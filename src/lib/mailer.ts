import nodemailer from 'nodemailer';
import { config } from '../config';
import { log } from '../logger';

const live = Boolean(config.smtp.host);

if (!live) log.warn('SMTP_HOST is not set: emails are only simulated (transport "mock") and will NOT reach anyone');

const transport = live
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

export async function sendMail(mail: { to: string; subject: string; text: string }) {
  const info = await transport.sendMail({ from: config.smtp.from, ...mail });
  return { id: String(info.messageId || ''), transport: live ? 'smtp' : 'mock' };
}
