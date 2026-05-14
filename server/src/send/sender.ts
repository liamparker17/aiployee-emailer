import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfigRow } from '../repos/smtpConfigs.js';

export function buildTransport(cfg: SmtpConfigRow & { password: string }): Transporter {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    pool: false,
  });
}
