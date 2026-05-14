// Tiny in-process SMTP server using smtp-tester
import smtpTester from 'smtp-tester';

export function startTestSmtp(port = 2525): { port: number; close: () => Promise<void>; lastMail: () => Promise<unknown> } {
  const mailServer = smtpTester.init(port);
  let lastResolve: ((v: unknown) => void) | null = null;
  mailServer.bind((_addr: string, _id: number, email: unknown) => { lastResolve?.(email); lastResolve = null; });
  return {
    port,
    close: () => new Promise<void>(res => mailServer.stop(res)),
    lastMail: () => new Promise(resolve => { lastResolve = resolve; }),
  };
}
