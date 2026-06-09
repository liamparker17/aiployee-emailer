import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { SmtpConfigRow } from '../repos/smtpConfigs.js';

export function buildTransport(cfg: SmtpConfigRow & { password: string }): Transporter {
  const opts: SMTPTransport.Options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
  };
  return nodemailer.createTransport(opts);
}
