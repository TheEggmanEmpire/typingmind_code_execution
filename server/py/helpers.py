# Native port of the plugin helpers; CHART_HTML is supplied as a file.
import os
with open(os.environ["CR_CHART_HTML"], encoding="utf-8") as _chart_file:
    _CR_CHART_HTML = _chart_file.read()

import os as _cr_os, sys as _cr_sys

def chart(data, x=None, y=None, kind='line', title='', path='chart.html', color=None, bins=None, spec=None, height=None):
    # Write an interactive chart page to /workspace/<path>; show it with preview_file.
    import json, math
    pd, np = _cr_sys.modules.get('pandas'), _cr_sys.modules.get('numpy')
    rows = data
    if pd is not None and isinstance(data, pd.Series):
        data = data.reset_index()
    if pd is not None and isinstance(data, pd.DataFrame):
        if not isinstance(data.index, pd.RangeIndex):
            data = data.reset_index()
        rows = json.loads(data.to_json(orient='records', date_format='iso'))
    elif isinstance(data, dict):
        if data and all(isinstance(v, (list, tuple)) for v in data.values()):
            keys = list(data)
            rows = [dict(zip(keys, vals)) for vals in zip(*data.values())]
        else:
            rows = [{'label': k, 'value': v} for k, v in data.items()]
            x = x or 'label'
            y = y or 'value'
    else:
        rows = [r if isinstance(r, dict) else {'x': i, 'y': r} for i, r in enumerate(list(rows))]
    def clean(v):
        if np is not None and isinstance(v, np.generic):
            v = v.item()
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
        return v if v is None or isinstance(v, (int, float, str, bool)) else str(v)
    rows = [{str(k): clean(v) for k, v in r.items()} for r in rows[:50000]]
    opts = dict(data=rows, x=x, y=y, kind=kind, title=title, color=color, bins=bins, spec=spec, height=height)
    page = _CR_CHART_HTML.replace('__OPTS__', json.dumps(opts, default=str).replace('</', '<\\/'))
    full = _cr_os.path.join(_cr_os.getcwd(), path)
    _cr_os.makedirs(_cr_os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(page)
    return path

def _cr_table_path(name):
    import re
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', str(name)):
        raise ValueError('table names use letters, digits and _')
    return _cr_os.path.join(_cr_os.getcwd(), '.cr/tables/%s.csv') % name

def share_table(name, data):
    # Share a table with the other languages: a DuckDB view, get_table() in R/JS/Python.
    import csv
    p = _cr_table_path(name)
    _cr_os.makedirs(_cr_os.path.dirname(p), exist_ok=True)
    pd = _cr_sys.modules.get('pandas')
    if pd is not None and isinstance(data, (pd.DataFrame, pd.Series)):
        df = data.to_frame() if isinstance(data, pd.Series) else data
        df.to_csv(p, index=not isinstance(df.index, pd.RangeIndex))
        return name
    rows = list(data)
    with open(p, 'w', newline='', encoding='utf-8') as f:
        if rows and isinstance(rows[0], dict):
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        else:
            csv.writer(f).writerows(rows)
    return name

def list_tables():
    d = _cr_os.path.join(_cr_os.getcwd(), '.cr/tables')
    return sorted(n[:-4] for n in _cr_os.listdir(d) if n.endswith('.csv')) if _cr_os.path.isdir(d) else []

def get_table(name):
    # A shared table: a pandas DataFrame when pandas is available, else a list of dicts.
    p = _cr_table_path(name)
    if not _cr_os.path.exists(p):
        raise FileNotFoundError('no shared table %r (shared tables: %s)' % (name, ', '.join(list_tables()) or 'none'))
    try:
        import pandas as pd
        return pd.read_csv(p)
    except ImportError:
        import csv
        with open(p, newline='', encoding='utf-8') as f:
            return list(csv.DictReader(f))

def read_text(path, max_chars=None):
    # Plain text of a PDF, DOCX, PPTX, XLSX, HTML or text file.
    ext = _cr_os.path.splitext(str(path))[1].lower()
    try:
        if ext == '.pdf':
            import pypdf
            t = '\n\n'.join((pg.extract_text() or '') for pg in pypdf.PdfReader(path).pages)
        elif ext == '.docx':
            import docx
            d = docx.Document(path)
            t = '\n'.join(p.text for p in d.paragraphs)
            for tb in d.tables:
                t += '\n' + '\n'.join('\t'.join(c.text for c in r.cells) for r in tb.rows)
        elif ext == '.pptx':
            from pptx import Presentation
            t = '\n\n'.join('--- slide %d ---\n' % (i + 1) + '\n'.join(sh.text_frame.text for sh in sl.shapes if sh.has_text_frame)
                            for i, sl in enumerate(Presentation(path).slides))
        elif ext in ('.xlsx', '.xlsm'):
            import openpyxl
            wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
            t = '\n\n'.join('--- sheet %s ---\n' % ws.title + '\n'.join('\t'.join('' if v is None else str(v) for v in r)
                            for r in ws.iter_rows(values_only=True)) for ws in wb.worksheets)
        elif ext in ('.html', '.htm'):
            from bs4 import BeautifulSoup
            with open(path, encoding='utf-8', errors='replace') as f:
                t = BeautifulSoup(f.read(), 'html.parser').get_text('\n')
        else:
            with open(path, encoding='utf-8', errors='replace') as f:
                t = f.read()
    except ModuleNotFoundError as e:
        pkg = {'pypdf': 'pypdf', 'docx': 'python-docx', 'pptx': 'python-pptx', 'openpyxl': 'openpyxl', 'bs4': 'beautifulsoup4'}.get(e.name, e.name)
        raise ModuleNotFoundError('read_text needs %s for %s files: pass packages: ["%s"]' % (pkg, ext, pkg)) from None
    return t[:max_chars] if max_chars else t
