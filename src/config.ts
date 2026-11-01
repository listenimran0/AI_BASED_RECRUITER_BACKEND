import 'dotenv/config';

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 4000),
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/recruiter',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  llm: {
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.LLM_BASE_URL || undefined,
    model: process.env.LLM_MODEL || 'gpt-4o-mini',

    priceIn: num(process.env.LLM_PRICE_IN, 0.15),
    priceOut: num(process.env.LLM_PRICE_OUT, 0.6),
  },

  serperKey: process.env.SERPER_API_KEY || '',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Recruiting Team <recruiting@example.test>',
  },

  recruiter: {
    name: process.env.RECRUITER_NAME || 'Md Imran Khan',
    company: process.env.COMPANY_NAME || 'Aironauts Technologies',
  },

  outreach: {
    defaultDailyLimit: num(process.env.DAILY_SEND_LIMIT, 20),

    dayMs: num(process.env.OUTREACH_DAY_MS, 24 * 60 * 60 * 1000),
    sweepEveryMs: num(process.env.SWEEP_EVERY_MS, 10_000),
    maxFollowUpAutoReplies: 1,
  },

  concurrency: {
    scoring: num(process.env.SCORING_CONCURRENCY, 5),
    drafting: num(process.env.DRAFTING_CONCURRENCY, 3),
  },

  calendlyUrl: process.env.CALENDLY_URL || '',
};

export const llmEnabled = Boolean(config.llm.apiKey);
