"""One request per process. All access is relative to an open workspace fd.

Reject every symlink during traversal, even internal ones. realpath checks
alone race with untrusted code renaming a directory while the helper runs.
O_NOFOLLOW + dir_fd prevents redirects to a sibling workspace or host path.
"""
import errno
import json
import os
import stat
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE = os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
ROOT_PATH = os.path.realpath(os.getcwd())
ROOT = os.open('.', DIRECTORY)


def denied():
    raise PermissionError(errno.EACCES, 'Path must stay inside the workspace.')


def parts(name, final_link=False):
    if not isinstance(name, str) or not name or '\x00' in name or name.startswith('/'):
        denied()
    bits = [p for p in name.split('/') if p not in ('', '.')]
    if not bits or '..' in bits:
        denied()
    # Early check gives a concrete escape error; fd traversal below is the
    # actual protection against links changing after this check.
    resolved = os.path.realpath(os.path.join(ROOT_PATH, *(bits[:-1] if final_link else bits)))
    if os.path.commonpath([ROOT_PATH, resolved]) != ROOT_PATH:
        denied()
    return bits


def parent(name, create=False, final_link=False):
    bits = parts(name, final_link)
    fd = os.dup(ROOT)
    try:
        for bit in bits[:-1]:
            if create:
                try:
                    os.mkdir(bit, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            new = os.open(bit, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd, bits[-1]
    except BaseException:
        os.close(fd)
        raise


def regular(fd):
    st = os.fstat(fd)
    if stat.S_ISDIR(st.st_mode):
        raise IsADirectoryError(errno.EISDIR, 'Path is a directory.')
    if not stat.S_ISREG(st.st_mode):
        denied()
    return st


def unlink_tree(fd, name):
    st = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(name, dir_fd=fd)
        return
    child = os.open(name, DIRECTORY, dir_fd=fd)
    try:
        for entry in os.listdir(child):
            unlink_tree(child, entry)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=fd)


def listing(fd, prefix=''):
    out = []
    for name in sorted(os.listdir(fd)):
        st = os.stat(name, dir_fd=fd, follow_symlinks=False)
        rel = prefix + name
        if stat.S_ISDIR(st.st_mode):
            child = os.open(name, DIRECTORY, dir_fd=fd)
            try:
                out.extend(listing(child, rel + '/'))
            finally:
                os.close(child)
        else:
            entry = {'path': rel, 'size': st.st_size, 'mtime': st.st_mtime_ns / 1000000}
            if stat.S_ISLNK(st.st_mode):
                entry['link'] = True
            out.append(entry)
    return out


def perform(req):
    op = req.get('op')
    if op in ('list', 'usage'):
        entries = sorted(listing(ROOT), key=lambda entry: entry['path'])
        return (entries if op == 'list' else sum(f['size'] for f in entries)), None
    if op == 'clear':
        for name in os.listdir(ROOT):
            unlink_tree(ROOT, name)
        return None, None
    if op not in ('read', 'write', 'stat', 'remove', 'rename'):
        raise OSError(errno.EINVAL, 'Unknown file operation.')
    try:
        fd, name = parent(req.get('path'), op == 'write', op in ('remove', 'rename'))
    except FileNotFoundError:
        if op in ('stat', 'remove'):
            return None, None
        raise
    try:
        if op == 'read':
            file = os.open(name, os.O_RDONLY | FILE, dir_fd=fd)
            try:
                st = regular(file)
                limit = req.get('maxBytes', 0)
                if not isinstance(limit, int) or limit < 0 or st.st_size > limit:
                    raise OSError(errno.EFBIG, 'File exceeds maxBytes.')
                chunks = []
                remaining = limit + 1
                while remaining:
                    data = os.read(file, min(remaining, 1024 * 1024))
                    if not data:
                        break
                    chunks.append(data)
                    remaining -= len(data)
                data = b''.join(chunks)
                if len(data) > limit:
                    raise OSError(errno.EFBIG, 'File exceeds maxBytes.')
                return None, data
            finally:
                os.close(file)
        if op == 'write':
            # Check type before truncating. O_NONBLOCK avoids hanging on a FIFO.
            file = os.open(name, os.O_WRONLY | os.O_CREAT | FILE, 0o600, dir_fd=fd)
            try:
                regular(file)
                size = req.get('size')
                if not isinstance(size, int) or size < 0:
                    raise OSError(errno.EINVAL, 'Invalid write size.')
                os.ftruncate(file, 0)
                remaining = size
                while remaining:
                    data = sys.stdin.buffer.read(min(remaining, 1024 * 1024))
                    if not data:
                        raise OSError(errno.EIO, 'Incomplete write payload.')
                    remaining -= len(data)
                    view = memoryview(data)
                    while view:
                        count = os.write(file, view)
                        view = view[count:]
            finally:
                os.close(file)
            return None, None
        if op == 'stat':
            try:
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return None, None
            if stat.S_ISLNK(st.st_mode):
                denied()
            return {'size': st.st_size, 'mtime': st.st_mtime_ns / 1000000, 'dir': stat.S_ISDIR(st.st_mode)}, None
        if op == 'remove':
            # Remove a final symlink itself, never its target (including escape
            # links, which path validation intentionally refuses for other ops).
            try:
                unlink_tree(fd, name)
            except FileNotFoundError:
                pass
            return None, None
        if op == 'rename':
            target, dest = parent(req.get('to'), True, True)
            try:
                os.rename(name, dest, src_dir_fd=fd, dst_dir_fd=target)
            finally:
                os.close(target)
            return None, None
    finally:
        os.close(fd)


def main():
    try:
        line = sys.stdin.buffer.readline(65537)
        if len(line) > 65536 or not line.endswith(b'\n'):
            raise OSError(errno.EINVAL, 'Invalid request line.')
        req = json.loads(line)
        result, data = perform(req)
        header = {'ok': True, 'size': len(data)} if data is not None else {'ok': True, 'result': result}
        sys.stdout.buffer.write(json.dumps(header, separators=(',', ':')).encode() + b'\n')
        if data is not None:
            sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        number = getattr(exc, 'errno', None)
        code = errno.errorcode.get(number, 'EACCES')
        if number in (errno.ELOOP, errno.ENOTDIR):
            code = 'EACCES'
        if number == errno.EFBIG:
            code = 'ETOOBIG'
        sys.stdout.write(json.dumps({'ok': False, 'code': code, 'error': str(exc)}, separators=(',', ':')) + '\n')
    finally:
        os.close(ROOT)


if __name__ == '__main__':
    main()
