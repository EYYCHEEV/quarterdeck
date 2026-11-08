import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    'restore-earliest-match': 'test_mail_fix2.AmbiguousHintTests.test_reviewer_pre_seed_reply_joins_the_real_mail_not_the_hostile_seed',
    'accept-ambiguous-match': 'test_mail_fix2.AmbiguousHintTests.test_two_stored_mails_in_one_thread_are_still_an_ambiguous_hint',
    'skip-fallthrough': 'test_mail_fix2.AmbiguousHintTests.test_ambiguous_hint_falls_through_in_the_existing_hint_order',
}
BOOTSTRAP = '''import importlib.util,io,json,sys,unittest
from pathlib import Path
module_path,root,*targets=sys.argv[1:]
sys.path[:0]=[str(Path(root)/"qd-web"),str(Path(root)),str(Path(root)/"tests")]
spec=importlib.util.spec_from_file_location("mail_api",module_path)
module=importlib.util.module_from_spec(spec)
sys.modules["mail_api"]=module
spec.loader.exec_module(module)
suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(target) for target in targets)
stream=io.StringIO()
result=unittest.TextTestRunner(stream=stream,verbosity=2).run(suite)
print(json.dumps({"tests":result.testsRun,"failures":[test.id() for test,_ in result.failures],"errors":[test.id() for test,_ in result.errors],"details":stream.getvalue() if result.errors else ""}))
raise SystemExit(0 if result.wasSuccessful() else 1)
'''


def run(module, targets):
    result = subprocess.run([sys.executable, '-B', '-c', BOOTSTRAP, str(module), str(ROOT), *targets], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    try:
        document = json.loads(result.stdout.splitlines()[-1])
    except (IndexError, ValueError):
        raise AssertionError('fault child produced no test result') from None
    return result.returncode, document


def mutate(source, fault):
    tree = ast.parse(source)
    owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ThreadTable')
    method = next(node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name == '_place_one')
    loop = next(node for node in method.body if isinstance(node, ast.For))
    if fault == 'restore-earliest-match':
        loop.body = ast.parse('found=db.execute("SELECT n FROM mails WHERE message_key = ? ORDER BY rowid LIMIT 1",(named,)).fetchone()\nif found is not None:\n thread=found[0]\n break').body
    elif fault == 'accept-ambiguous-match':
        loop.body[1].test = ast.parse('len(found)>=1', mode='eval').body
    elif fault == 'skip-fallthrough':
        loop.body[1:1] = ast.parse('if len(found)!=1:\n break').body
    else:
        raise AssertionError('unknown fault')
    return ast.unparse(ast.fix_missing_locations(tree)) + '\n'


def main():
    original = ROOT / 'qd-web/mail_api.py'
    code, result = run(original, list(TARGETS.values()))
    if code or result['tests'] != 3 or result['failures'] or result['errors']:
        raise AssertionError('normal fault targets failed: ' + json.dumps(result))
    print('FIX2_FAULT_BASELINE_PASS tests=3', flush=True)
    with tempfile.TemporaryDirectory() as folder:
        for fault, target in TARGETS.items():
            copy = Path(folder) / (fault + '.py')
            copy.write_text(mutate(original.read_text(), fault))
            code, result = run(copy, [target])
            if code != 1 or result['tests'] != 1 or result['errors'] or not result['failures'] or any(not failure.startswith(target) for failure in result['failures']):
                raise AssertionError('fault not caught by behavioral assertion: ' + fault + ' ' + json.dumps(result))
            print('FIX2_FAULT_CAUGHT name=' + fault + ' assertions=' + str(len(result['failures'])), flush=True)
    print('FIX2_FAULTS_PASS caught=3 total=3 errors=0', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
