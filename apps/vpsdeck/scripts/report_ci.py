#!/usr/bin/env python3
"""Surface compiler/test failures as check annotations, not only remote log links."""
import pathlib, re, sys, xml.etree.ElementTree as ET

def escape(text):
    return text.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')

for line in pathlib.Path(sys.argv[1]).read_text(errors='replace').splitlines():
    m = re.match(r'e: file://(.+?):(\d+):(\d+) (.+)', line)
    if m:
        file, row, col, message = m.groups()
        relative = 'apps/vpsdeck/' + file.split('/apps/vpsdeck/', 1)[-1]
        print(f'::error file={relative},line={row},col={col}::{escape(message)}')
for report in pathlib.Path('app/build/test-results').glob('**/TEST-*.xml'):
    for case in ET.parse(report).getroot().iter('testcase'):
        for tag in ('failure', 'error'):
            fail = case.find(tag)
            if fail is not None:
                print(f"::error::{escape(case.get('classname', '') + '.' + case.get('name', '') + ': ' + fail.get('message', 'failed'))}")
