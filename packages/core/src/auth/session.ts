/// <reference path="../types/connect-pg-simple.d.ts" />
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import type pg from 'pg';
import type { Config } from '../config.js';

export async function registerSessions(app: FastifyInstance, cfg: Config, pool: pg.Pool) {
  const PgStore = connectPgSimple(session);
  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: cfg.sessionSecret,
    cookieName: 'aip_sid',
    cookie: {
      httpOnly: true,
      secure: cfg.env === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    },
    rolling: true,
    saveUninitialized: false,
    store: new PgStore({ pool, tableName: 'sessions' }) as never,
  });
}

declare module 'fastify' {
  interface Session {
    userId?: string;
    tenantId?: string | null;
    role?: 'super_admin' | 'tenant_admin' | 'tenant_user';
    activeTenantId?: string;
  }
}
