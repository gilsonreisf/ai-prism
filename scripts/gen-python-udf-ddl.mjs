// Generates bundle/python_udf_ddl.py from the canonical JS source
// (shared/pythonUdf.js), so the deploy-time job and the runtime app provision
// byte-for-byte the same UDF. Run: node scripts/gen-python-udf-ddl.mjs
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PYTHON_UDF_BODY,
  PYTHON_UDF_PARAM_COMMENT,
  PYTHON_UDF_COMMENT,
} from '../shared/pythonUdf.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', 'bundle', 'python_udf_ddl.py')

// Emit the three pieces as Python triple-quoted literals, then a builder that
// assembles the exact same DDL string as shared/pythonUdf.js#pythonUdfDDL.
const py = `# AUTO-GENERATED from shared/pythonUdf.js by scripts/gen-python-udf-ddl.mjs.
# Do not edit by hand — edit the JS source and re-run the generator so the
# deploy-time (bundle job) and runtime (app) UDF definitions stay identical.

_BODY = r'''${PYTHON_UDF_BODY}'''

_PARAM_COMMENT = ${JSON.stringify(PYTHON_UDF_PARAM_COMMENT)}
_COMMENT = ${JSON.stringify(PYTHON_UDF_COMMENT)}


def python_udf_ddl(fq_name: str) -> str:
    """Idempotent CREATE OR REPLACE FUNCTION DDL for the built-in Python UDF."""
    return (
        f"CREATE OR REPLACE FUNCTION {fq_name}(code STRING COMMENT '{_PARAM_COMMENT}')\\n"
        " RETURNS STRING\\n"
        " LANGUAGE PYTHON\\n"
        f" COMMENT '{_COMMENT}'\\n"
        f" AS $$" + _BODY + "$$"
    )
`

writeFileSync(out, py)
console.log('Wrote', out)
