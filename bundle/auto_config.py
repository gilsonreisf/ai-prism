# Databricks notebook source
# AI Prism — post-deploy auto-configuration.
#
# Runs as a bundle job task right after `databricks bundle deploy`. Its job is to
# make a fresh workspace "just work" with zero manual infra steps:
#
#   1. Discover the deploying user's email (the job runs as them) and the
#      workspace host — these become APP_OWNER_EMAIL (bootstrap admin) and the
#      base URL, so no one has to hand-edit app.yaml.
#   2. Provision the built-in Python UDF (ai_prism_python_exec) in the configured
#      catalog/schema, so the "execute_python" tool works on the very first turn
#      instead of being lazily created later. The DDL is the SAME one the app
#      uses at runtime (kept in sync via bundle/python_udf_ddl.py, generated from
#      shared/pythonUdf.js) so the two can never drift.
#   3. Print a summary of the resolved config (warehouse id, Lakebase host/db)
#      that the operator can paste if they ever need to inspect it.
#
# Everything here is idempotent — safe to re-run on every deploy.

# COMMAND ----------

dbutils.widgets.text("catalog", "main", "Tools catalog")
dbutils.widgets.text("schema", "default", "Tools schema")
dbutils.widgets.text("warehouse_id", "", "SQL Warehouse id")
dbutils.widgets.text("lakebase_host", "", "Lakebase read/write host")
dbutils.widgets.text("lakebase_db", "databricks_postgres", "Lakebase database")
dbutils.widgets.text("app_name", "ai-prism", "Databricks App name")
dbutils.widgets.text("dashboard_id", "", "AI/BI cost dashboard id")

catalog = dbutils.widgets.get("catalog").strip() or "main"
schema = dbutils.widgets.get("schema").strip() or "default"
warehouse_id = dbutils.widgets.get("warehouse_id").strip()
lakebase_host = dbutils.widgets.get("lakebase_host").strip()
lakebase_db = dbutils.widgets.get("lakebase_db").strip() or "databricks_postgres"
app_name = dbutils.widgets.get("app_name").strip() or "ai-prism"
dashboard_id = dbutils.widgets.get("dashboard_id").strip()

# COMMAND ----------

# The deploying user — the job runs on-behalf-of whoever ran `bundle deploy`.
deployer_email = (
    spark.sql("SELECT current_user() AS u").collect()[0]["u"] or ""
).strip().lower()

workspace_host = (
    spark.conf.get("spark.databricks.workspaceUrl", "") or ""
).strip()
if workspace_host and not workspace_host.startswith("http"):
    workspace_host = "https://" + workspace_host

print(f"Deployer (bootstrap admin): {deployer_email}")
print(f"Workspace host:             {workspace_host}")
print(f"Tools catalog.schema:       {catalog}.{schema}")
print(f"SQL Warehouse id:           {warehouse_id or '(not provided)'}")
print(f"Lakebase host / db:         {lakebase_host or '(not provided)'} / {lakebase_db}")

# COMMAND ----------

# Provision the built-in Python UDF. The DDL is generated from the single source
# of truth (shared/pythonUdf.js) into bundle/python_udf_ddl.py so the deploy-time
# and runtime definitions are byte-for-byte identical.
from python_udf_ddl import python_udf_ddl  # noqa: E402

fq_name = f"{catalog}.{schema}.ai_prism_python_exec"
spark.sql(f"CREATE CATALOG IF NOT EXISTS {catalog}")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}")
spark.sql(python_udf_ddl(fq_name))
print(f"Provisioned UDF: {fq_name}")

# Smoke-test it so a broken deploy fails loudly here, not on a user's first turn.
check = spark.sql(
    f"SELECT {fq_name}('result = 6 * 7') AS out"
).collect()[0]["out"]
assert check.strip() == "42", f"UDF smoke test failed: got {check!r}"
print(f"UDF smoke test OK (6*7 = {check.strip()})")

# COMMAND ----------

# Publish the AI/BI cost dashboard. `bundle deploy` creates/updates it as a DRAFT;
# publishing makes it viewable by other admins right after deploy (no manual step).
# Idempotent — re-publishing on every deploy just refreshes the published version.
if dashboard_id:
    import json
    import urllib.request

    ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
    _host = workspace_host or ("https://" + ctx.browserHostName().get())
    _token = ctx.apiToken().get()
    req = urllib.request.Request(
        f"{_host}/api/2.0/lakeview/dashboards/{dashboard_id}/published",
        data=json.dumps({"embed_credentials": False}).encode(),
        headers={"Authorization": f"Bearer {_token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read().decode() or "{}")
        print(f"Published cost dashboard {dashboard_id} "
              f"(revision {body.get('revision_create_time', 'n/a')}).")
    except Exception as e:  # non-fatal: the dashboard still exists as a draft
        print(f"WARNING: could not publish dashboard {dashboard_id}: {e}")
        print("Open it in the workspace and click Publish manually.")
else:
    print("No dashboard_id provided; skipping publish (deploy leaves it as a draft).")

# COMMAND ----------

# Surface the resolved config. APP_OWNER_EMAIL / SQL_WAREHOUSE_ID / PGHOST etc.
# are wired into the app via the bundle's app resource env, but printing them
# here gives the operator a single place to confirm what the deploy resolved.
print("=== AI Prism resolved configuration ===")
print(f"APP_OWNER_EMAIL   = {deployer_email}")
print(f"DATABRICKS_APP_NAME = {app_name}")
print(f"SQL_WAREHOUSE_ID  = {warehouse_id}")
print(f"TOOLS_CATALOG     = {catalog}")
print(f"TOOLS_SCHEMA      = {schema}")
print(f"PGHOST            = {lakebase_host}")
print(f"PGDATABASE        = {lakebase_db}")
print(f"COST_DASHBOARD_ID = {dashboard_id or '(not provided)'}")
print("Auto-config complete.")
