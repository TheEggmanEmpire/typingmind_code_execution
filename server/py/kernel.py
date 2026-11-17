"""Persistent native Python kernel, JSON frames on fd 3 (in) and fd 4 (out).

User stdout and stderr, including fd writes from extensions and subprocesses,
share one pipe. A barrier drains that pipe before each completion event.
"""
import ast
import base64
import asyncio
import builtins
import importlib
import inspect
import io
import json
import linecache
import os
import pickle
import queue
import secrets
import site
import signal
import struct
import sys
import threading
import traceback
import types

stdio_control = os.environ.get('CR_CONTROL_STDIO') == '1'
control_prefix = os.environ.get('CR_CONTROL_PREFIX', '')
control_in = os.fdopen(os.dup(0) if stdio_control else 3, 'rb', buffering=0)
control_out = os.fdopen(os.dup(2) if stdio_control else 4, 'wb', buffering=0)
event_lock = threading.Lock()
active_id = None
executing = False

def emit(event):
    data = json.dumps(event, ensure_ascii=False).encode('utf-8')
    with event_lock:
        if stdio_control:
            control_out.write(control_prefix.encode() + base64.b64encode(data) + b'\n')
        else:
            control_out.write(struct.pack('>I', len(data)) + data)

def read_exact(n):
    result = bytearray()
    while len(result) < n:
        chunk = control_in.read(n - len(result))
        if not chunk:
            return None
        result.extend(chunk)
    return bytes(result)

# One reader preserves the ordering of Python, native and subprocess writes.
capture_read, capture_write = os.pipe()
os.dup2(capture_write, 1)
os.dup2(capture_write, 2)
os.close(capture_write)
sys.stdout = os.fdopen(os.dup(1), 'w', buffering=1, encoding='utf-8', errors='replace')
sys.stderr = os.fdopen(os.dup(2), 'w', buffering=1, encoding='utf-8', errors='replace')
barrier = ('\x00cr-' + secrets.token_hex(24) + '\x00').encode()
drained = threading.Event()

def reader():
    import codecs
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    pending = b''
    while True:
        chunk = os.read(capture_read, 8192)
        if not chunk:
            break
        pending += chunk
        while pending:
            pos = pending.find(barrier)
            if pos >= 0:
                if pos:
                    emit({'id': active_id, 'type': 'output', 'text': decoder.decode(pending[:pos])})
                pending = pending[pos + len(barrier):]
                drained.set()
                continue
            # Retain only a possible partial marker, never arbitrary output.
            keep = 0
            for n in range(1, min(len(pending), len(barrier) - 1) + 1):
                if pending.endswith(barrier[:n]):
                    keep = n
            ready = pending[:-keep] if keep else pending
            if ready:
                emit({'id': active_id, 'type': 'output', 'text': decoder.decode(ready)})
            pending = pending[-keep:] if keep else b''
            break
threading.Thread(target=reader, daemon=True).start()

def flush_output():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    # libc stdio buffers belong to native libraries, not sys.stdout.
    try:
        import ctypes
        ctypes.CDLL(None).fflush(None)
    except Exception:
        pass
    drained.clear()
    os.write(1, barrier)
    drained.wait(2)

user_module = types.ModuleType('__main__')
sys.modules[user_module.__name__] = user_module
namespace = user_module.__dict__
namespace['__builtins__'] = dict(vars(builtins))
import helpers
for helper in ('chart', 'share_table', 'get_table', 'list_tables', 'read_text'):
    namespace[helper] = getattr(helpers, helper)
baseline = set(namespace)
def_sources = {}
seen_secrets = set()
prior_env = {}

def session_path():
    return os.path.join(os.environ['WORKSPACE'], '.cr', 'session.pkl')

def register(source, filename):
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)

def save_state():
    imports, definitions, values, skipped = {}, [], {}, []
    for name, value in list(namespace.items()):
        if name in baseline or name.startswith('__'):
            continue
        try:
            if isinstance(value, types.ModuleType):
                imports[name] = value.__name__
            elif (inspect.isfunction(value) or inspect.isclass(value)) and value.__module__ == user_module.__name__:
                source = def_sources.get(name)
                if source:
                    definitions.append((name, source))
                else:
                    skipped.append(name)
            else:
                data = pickle.dumps(value, protocol=4)
                if any(s.encode() in data for s in seen_secrets if s):
                    skipped.append(name)
                else:
                    values[name] = data
        except Exception:
            skipped.append(name)
    state = {'v': 1, 'imports': imports, 'defs': definitions, 'data': values, 'skipped': skipped}
    target = session_path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target + '.tmp', 'wb') as f:
        pickle.dump(state, f, protocol=4)
    os.replace(target + '.tmp', target)
    return skipped

def restore_state():
    if not os.path.exists(session_path()):
        return []
    try:
        with open(session_path(), 'rb') as f:
            state = pickle.load(f)
    except Exception:
        return ['all saved variables (unreadable session)']
    skipped = list(state.get('skipped', []))
    for name, mod in state.get('imports', {}).items():
        try:
            namespace[name] = importlib.import_module(mod)
        except Exception:
            skipped.append(name)
    # Constants can be required by decorators or class bodies; restore ordinary
    # values before definitions, then instances after their classes exist.
    delayed = {}
    for name, data in state.get('data', {}).items():
        try:
            namespace[name] = pickle.loads(data)
        except Exception:
            delayed[name] = data
    for name, source in state.get('defs', []):
        try:
            filename = '<session:%s>' % name
            register(source, filename)
            exec(compile(source, filename, 'exec'), namespace)
            def_sources[name] = source
        except Exception:
            skipped.append(name)
    for name, data in delayed.items():
        try:
            namespace[name] = pickle.loads(data)
        except Exception:
            skipped.append(name)
    return sorted(set(skipped))

def interrupt(signum, frame):
    if executing:
        raise KeyboardInterrupt()
signal.signal(signal.SIGINT, interrupt)

restore_skipped = restore_state()
# Consume the snapshot: a later hard kill must not replay stale variables.
try:
    os.remove(session_path())
except FileNotFoundError:
    pass
emit({'type': 'ready', 'skipped': restore_skipped})

def clean_error(exc, code):
    lines = ['Traceback (most recent call last):']
    source = code.splitlines()
    for frame in traceback.extract_tb(exc.__traceback__):
        if frame.filename == '<run>' or frame.filename.startswith('<session:'):
            lines.append('  File "%s", line %d, in %s' % (frame.filename, frame.lineno, frame.name))
            text = frame.line or (source[frame.lineno - 1] if frame.filename == '<run>' and frame.lineno <= len(source) else '')
            if text:
                lines.append('    ' + text.strip())
    if isinstance(exc, SyntaxError):
        lines.append('  File "<run>", line %d' % (exc.lineno or 1))
        if exc.text:
            lines.append('    ' + exc.text.strip())
    lines.append('%s: %s' % (type(exc).__name__, exc))
    return '\n'.join(lines) + '\n'

def figures():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return []
    saved = []
    try:
        for number in plt.get_fignums():
            n = 1
            while os.path.exists('figure_%d.png' % n):
                n += 1
            name = 'figure_%d.png' % n
            plt.figure(number).savefig(name, dpi=110, bbox_inches='tight')
            saved.append(name)
    finally:
        plt.close('all')
    return saved

requests = queue.Queue()

def control_reader():
    while True:
        try:
            header = read_exact(4)
            if header is None:
                break
            size = struct.unpack('>I', header)[0]
            if size > 64 * 1024 * 1024:
                break
            data = read_exact(size)
            if data is None:
                break
            request = json.loads(data.decode('utf-8'))
            if request.get('op') == 'interrupt':
                # Signal the actual interpreter, not its namespace launcher.
                # This also interrupts time.sleep and interruptible native I/O.
                if executing and request.get('id') == active_id:
                    os.kill(os.getpid(), signal.SIGINT)
            else:
                requests.put(request)
        except Exception:
            break
    requests.put(None)

threading.Thread(target=control_reader, daemon=True).start()
while True:
    request = requests.get()
    if request is None:
        break
    active_id = request.get('id')
    if request.get('op') == 'stop':
        try:
            skipped = save_state()
            emit({'id': active_id, 'type': 'saved', 'skipped': skipped})
        except BaseException as exc:
            emit({'id': active_id, 'type': 'saved', 'error': str(exc)})
        break
    code = request.get('code', '')
    status = 0
    notes = []
    # Per-request secrets cannot linger as environment variables in later runs.
    for name, old in prior_env.items():
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old
    prior_env = {name: os.environ.get(name) for name in request.get('secrets', {})}
    os.environ.update(request.get('secrets', {}))
    seen_secrets.update(request.get('secrets', {}).values())
    os.chdir(request['cwd'])
    user_site = site.getusersitepackages()
    if os.path.isdir(user_site) and user_site not in sys.path:
        site.addsitedir(user_site)
    importlib.invalidate_caches()
    if os.getcwd() not in sys.path:
        sys.path.insert(0, os.getcwd())
    sys.stdin = io.StringIO(request.get('stdin', ''))
    register(code, '<run>')
    executing = True
    try:
        tree = ast.parse(code, '<run>', 'exec')
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                first = min([node.lineno] + [d.lineno for d in node.decorator_list])
                def_sources[node.name] = '\n'.join(code.splitlines()[first - 1:node.end_lineno]) + '\n'
            elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Lambda):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        def_sources[target.id] = ast.get_source_segment(code, node) + '\n'
        expression = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
        program = compile(tree, '<run>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        value = eval(program, namespace)
        if inspect.isawaitable(value):
            asyncio.run(value)
        if expression is not None:
            value = eval(compile(expression, '<run>', 'eval', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), namespace)
            if inspect.isawaitable(value):
                value = asyncio.run(value)
            if value is not None:
                print(repr(value))
    except BaseException as exc:
        status = 1
        print(clean_error(exc, code), end='', file=sys.stderr)
        if isinstance(exc, ModuleNotFoundError) and exc.name:
            emit({'id': active_id, 'type': 'missing', 'module': exc.name.split('.')[0]})
    finally:
        executing = False
        try:
            saved = figures()
            if saved:
                notes.append('matplotlib figures saved: ' + ', '.join(saved))
        except Exception as exc:
            notes.append('Could not save matplotlib figures: ' + str(exc))
        flush_output()
        emit({'id': active_id, 'type': 'done', 'exitCode': status, 'notes': notes})
        active_id = None
