"""Native SQLite / DuckDB runner, bounded aligned statement results."""
import json
import os
import sqlite3
import sys

def statements(source):
    # sqlite's parser handles quotes, comments, and trigger BEGIN/END bodies.
    pending = ''
    for char in source:
        pending += char
        if char == ';' and sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    if pending.strip():
        yield pending

def table(cursor):
    names = [str(col[0]) for col in cursor.description]
    rows = cursor.fetchmany(501)
    clipped = len(rows) > 500
    rows = rows[:500]
    cells = [[('NULL' if x is None else str(x)).replace('\n', '\\n')[:300] for x in row] for row in rows]
    widths = [max([len(n)] + [len(row[i]) for row in cells]) for i, n in enumerate(names)]
    print(' | '.join(n.ljust(widths[i]) for i, n in enumerate(names)))
    print('-+-'.join('-' * n for n in widths))
    for row in cells:
        print(' | '.join(v.ljust(widths[i]) for i, v in enumerate(row)))
    print('(%d rows%s)' % (len(rows), ', first 500 shown' if clipped else ''))

def main():
    kind, code = sys.argv[1], open(sys.argv[2], encoding='utf-8').read()
    os.makedirs('.cr', exist_ok=True)
    if kind == 'duckdb':
        try:
            import duckdb
        except ImportError:
            sys.exit('duckdb is not installed. Use sql (SQLite), or install the duckdb Python package.')
        conn = duckdb.connect('.cr/duck.db')
        directory = '.cr/tables'
        if os.path.isdir(directory):
            for filename in os.listdir(directory):
                if filename.endswith('.csv'):
                    name = filename[:-4].replace('"', '""')
                    source = os.path.abspath(os.path.join(directory, filename)).replace("'", "''")
                    conn.execute('CREATE OR REPLACE TEMP VIEW "%s" AS SELECT * FROM read_csv_auto(\'%s\')' % (name, source))
    else:
        conn = sqlite3.connect('data.sqlite')
    try:
        for statement in statements(code):
            cursor = conn.execute(statement)
            if cursor.description:
                table(cursor)
            else:
                print('OK' + (' (%d rows affected)' % cursor.rowcount if cursor.rowcount >= 0 else ''))
            if kind == 'sql':
                cursor.close()
        conn.commit()
    finally:
        conn.close()

try:
    main()
except Exception as exc:
    print('%s: %s' % (type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
