const RISKY_WORDS = /\b(offer|salary|compensation|pay|package|equity|bonus|guarantee|guaranteed|contract|visa|relocat\w*|promise|negotiat\w*)\b/i;
const MONEY = /[$€£৳]\s?\d|\d\s?(k|usd|eur|gbp|bdt)\b/i;

export type AutoReplyCheck = {
  label: string;
  confidence: number;
  injectionFlag: boolean;
  body: string;
  bookingUrl?: string;
  autoRepliesAlreadySent: number;
  maxAutoReplies: number;
};

export function checkAutoReply(input: AutoReplyCheck): { safe: boolean; reason: string } {
  if (!['wants_meeting', 'interested'].includes(input.label)) {
    return { safe: false, reason: `"${input.label}" replies always need a human` };
  }
  if (input.confidence < 0.8) return { safe: false, reason: 'classification confidence is below 0.8' };
  if (input.injectionFlag) return { safe: false, reason: 'the message looks like it contains instructions aimed at the AI' };
  if (input.autoRepliesAlreadySent >= input.maxAutoReplies) return { safe: false, reason: 'auto-reply limit for this candidate reached' };
  if (input.body.length > 900) return { safe: false, reason: 'draft is unusually long' };
  if (RISKY_WORDS.test(input.body) || MONEY.test(input.body)) {
    return { safe: false, reason: 'draft touches money, offers or promises' };
  }
  if (input.label === 'wants_meeting' && input.bookingUrl && !input.body.includes(input.bookingUrl)) {
    return { safe: false, reason: 'draft is missing the booking link' };
  }
  return { safe: true, reason: 'all checks passed' };
}
