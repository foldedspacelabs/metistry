import pg from "pg";
import { intEnv, optionalEnv, requireEnv } from "@foldedspacelabs/metistry-core";

export function makePool(): pg.Pool {
  return new pg.Pool({
    host: optionalEnv("METISTRY_DB_HOST", "127.0.0.1"),
    port: intEnv("METISTRY_DB_PORT", 5432),
    database: optionalEnv("METISTRY_DB_NAME", "metistry"),
    user: optionalEnv("METISTRY_DB_USER", "metistry"),
    password: requireEnv("METISTRY_DB_PASSWORD"),
    max: intEnv("METISTRY_DB_POOL", 10),
  });
}
