import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: unknown,
  ) { super(message); }
}

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AppError) {
    return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid request body', details: err.issues } });
  }
  reply.log.error({ err }, 'unhandled');
  return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
}
