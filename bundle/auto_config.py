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
dbutils.widgets.text("image_volume_catalog", "ai_prism", "Image store catalog")
dbutils.widgets.text("image_volume_schema", "default", "Image store schema")
dbutils.widgets.text("image_volume_name", "ai_prism_images", "Image store volume")
dbutils.widgets.text("app_sp_client_id", "", "App service principal client id")
dbutils.widgets.text("lakebase_port", "5432", "Lakebase port")
dbutils.widgets.text("lakebase_endpoint", "", "Lakebase endpoint path (projects/../branches/../endpoints/..)")

catalog = dbutils.widgets.get("catalog").strip() or "main"
schema = dbutils.widgets.get("schema").strip() or "default"
warehouse_id = dbutils.widgets.get("warehouse_id").strip()
lakebase_host = dbutils.widgets.get("lakebase_host").strip()
lakebase_db = dbutils.widgets.get("lakebase_db").strip() or "databricks_postgres"
app_name = dbutils.widgets.get("app_name").strip() or "ai-prism"
dashboard_id = dbutils.widgets.get("dashboard_id").strip()
image_catalog = dbutils.widgets.get("image_volume_catalog").strip() or "ai_prism"
image_schema = dbutils.widgets.get("image_volume_schema").strip() or "default"
image_volume = dbutils.widgets.get("image_volume_name").strip() or "ai_prism_images"
app_sp_client_id = dbutils.widgets.get("app_sp_client_id").strip()
lakebase_port = dbutils.widgets.get("lakebase_port").strip() or "5432"
lakebase_endpoint = dbutils.widgets.get("lakebase_endpoint").strip()

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

# Provision the DEDICATED image store (own catalog, kept separate from the tools
# catalog so AI Prism's generated images never mix with other workspace assets)
# and grant the app service principal the volume privileges it needs. The app
# writes/reads image bytes as its SP (not per-user OBO), so it must hold
# READ/WRITE VOLUME here; per-user isolation stays app-level (user_email).
# Idempotent — safe on every deploy.
spark.sql(f"CREATE CATALOG IF NOT EXISTS `{image_catalog}` "
          f"COMMENT 'AI Prism app-owned storage (generated images, etc.)'")
spark.sql(f"CREATE SCHEMA IF NOT EXISTS `{image_catalog}`.`{image_schema}`")
spark.sql(f"CREATE VOLUME IF NOT EXISTS `{image_catalog}`.`{image_schema}`.`{image_volume}`")
print(f"Provisioned image volume: {image_catalog}.{image_schema}.{image_volume}")

if app_sp_client_id:
    spark.sql(f"GRANT USE CATALOG ON CATALOG `{image_catalog}` TO `{app_sp_client_id}`")
    spark.sql(f"GRANT USE SCHEMA, CREATE VOLUME, READ VOLUME, WRITE VOLUME "
              f"ON SCHEMA `{image_catalog}`.`{image_schema}` TO `{app_sp_client_id}`")
    print(f"Granted image-store privileges to app SP {app_sp_client_id}")
else:
    print("WARNING: no app_sp_client_id provided — grant READ/WRITE VOLUME on "
          f"{image_catalog}.{image_schema} to the app service principal manually.")

# COMMAND ----------

# Provision the Lakebase Postgres ROLE for the app's service principal, so the
# app can connect to Lakebase as itself (app authorization — the app uses its SP
# OAuth token as the PG password; per-user isolation stays app-level via the
# user_email WHERE clauses). WITHOUT this role the app's SP has no PG login and
# the whole schema never gets created (0 tables) — and because ensureSchema runs
# on the first request, EVERY authenticated call fails at the DB with SQLSTATE
# 28000, surfaced to the user as "External authorization failed".
#
# This runs as the DEPLOYER. The Lakebase "Autoscaling" product
# (projects/branches/endpoints) has no REST roles API; the supported mechanism is
# the `databricks_auth` extension's `databricks_create_role(identity, type)`
# function, run over SQL. The app then applies its own table GRANTs at runtime
# (see ensureSpGrants in db.js), but that only works once this role exists — so
# we create it here, idempotently.
if lakebase_host and app_sp_client_id and lakebase_endpoint:
    try:
        import psycopg2  # present on serverless/DBR notebook images
    except ImportError:
        import subprocess, sys as _sys
        subprocess.check_call([_sys.executable, "-m", "pip", "install", "-q", "psycopg2-binary"])
        import psycopg2

    # Lakebase requires an OAuth JWT as the PG password. The notebook's runtime
    # auth can't mint one directly (config.oauth_token() isn't available under
    # runtime auth), so we use the Lakebase credentials API, which returns a
    # short-lived JWT scoped to the endpoint — connecting as the deployer, whose
    # identity-federated PG login auto-exists on first connect.
    from databricks.sdk import WorkspaceClient
    _w = WorkspaceClient()
    _cred = _w.api_client.do(
        "POST", "/api/2.0/postgres/credentials",
        body={"endpoint": lakebase_endpoint},
    )
    pg_token = _cred["token"]

    conn = psycopg2.connect(
        host=lakebase_host,
        port=int(lakebase_port),
        dbname=lakebase_db,
        user=deployer_email,
        password=pg_token,
        sslmode="require",
        connect_timeout=30,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS databricks_auth")
            # role name = SP client id. Idempotent: skip if it already exists.
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app_sp_client_id,))
            if cur.fetchone():
                print(f"Lakebase role for app SP already exists: {app_sp_client_id}")
            else:
                cur.execute(
                    "SELECT databricks_create_role(%s, %s)",
                    (app_sp_client_id, "SERVICE_PRINCIPAL"),
                )
                print(f"Created Lakebase role for app SP: {app_sp_client_id}")
            # let the SP bootstrap its schema on first run (the app's ensureSpGrants
            # then handles table-level DML grants once tables exist)
            cur.execute(f'GRANT CREATE, USAGE ON SCHEMA public TO "{app_sp_client_id}"')
            cur.execute(f'GRANT CREATE ON DATABASE "{lakebase_db}" TO "{app_sp_client_id}"')
            print("Granted CREATE/USAGE on public + CREATE on database to app SP.")

            # Seed the deployer as the bootstrap ADMIN. The app reads admins from
            # this table (server/authz.js) — a persistent, redeploy-safe source of
            # truth. We do this here (not via APP_OWNER_EMAIL) because the bundle's
            # config.env does NOT reach the running app; only app.yaml + resource
            # injections do, and app.yaml can't carry the (dynamic) deployer email.
            # Create the table if the app hasn't booted yet (same shape as db.js);
            # idempotent upsert so re-deploys are safe.
            if deployer_email:
                cur.execute(
                    "CREATE TABLE IF NOT EXISTS app_admins ("
                    " principal TEXT PRIMARY KEY,"
                    " kind TEXT NOT NULL DEFAULT 'user',"
                    " added_by TEXT NOT NULL,"
                    " created_at TIMESTAMPTZ DEFAULT NOW())"
                )
                cur.execute(
                    "INSERT INTO app_admins (principal, kind, added_by) VALUES (%s,'user','auto-config')"
                    " ON CONFLICT (principal) DO NOTHING",
                    (deployer_email,),
                )
                # the app SP owns the schema; let it manage this table too
                cur.execute(f'GRANT SELECT, INSERT, UPDATE, DELETE ON app_admins TO "{app_sp_client_id}"')
                print(f"Seeded bootstrap admin: {deployer_email}")
    finally:
        conn.close()
else:
    print("WARNING: lakebase_host / app_sp_client_id / lakebase_endpoint missing — "
          "skipping SP role provisioning. The app SP won't be able to connect to "
          "Lakebase; create the role manually with "
          "databricks_create_role(<client_id>,'SERVICE_PRINCIPAL').")

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
print(f"IMAGE_VOLUME      = {image_catalog}.{image_schema}.{image_volume}")
print(f"PGHOST            = {lakebase_host}")
print(f"PGDATABASE        = {lakebase_db}")
print(f"COST_DASHBOARD_ID = {dashboard_id or '(not provided)'}")
print("Auto-config complete.")
