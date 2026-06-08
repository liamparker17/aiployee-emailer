declare module 'connect-pg-simple' {
  import type session from 'express-session';
  function connectPgSimple(s: typeof session): new (opts: {
    pool?: import('pg').Pool;
    conString?: string;
    tableName?: string;
    schemaName?: string;
    createTableIfMissing?: boolean;
    pruneSessionInterval?: number | false;
  }) => session.Store;
  export = connectPgSimple;
}
