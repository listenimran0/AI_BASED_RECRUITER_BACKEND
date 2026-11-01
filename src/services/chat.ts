import { Conversation, Message, type CardRef } from '../models';
import { emit } from '../lib/events';

export const GREETING =
  "Hi, I'm your AI recruiting co-worker. I can take a role from job description to hire: create the job, find and score candidates, run outreach, handle replies and track the funnel.\n\n" +
  'To begin, paste a job description or send me a link to one.';

export async function createConversation() {
  const conversation = await Conversation.create({});
  await postAssistant(conversation._id, GREETING, [
    { type: 'suggestions', ref: { items: ['Use the sample job description'] } },
  ]);
  return conversation;
}

export async function postAssistant(conversationId: unknown, content: string, cards: CardRef[] = []) {
  const message = await Message.create({ conversationId, role: 'assistant', content, cards });
  emit({ type: 'message', conversationId: String(conversationId), message: message.toJSON() });
  return message;
}

export async function postUser(conversationId: unknown, content: string) {
  const message = await Message.create({ conversationId, role: 'user', content });
  emit({ type: 'message', conversationId: String(conversationId), message: message.toJSON() });
  return message;
}
