import { Router } from 'express';
import { must } from '../lib/http';
import { Campaign, Candidate, OutreachMessage } from '../models';
import { approveCampaign, setCampaignPaused } from '../services/campaigns';

export const campaignsRouter = Router();

campaignsRouter.get('/campaigns/:id', async (req, res) => {
  const campaign = await must(Campaign.findById(req.params.id), 'Campaign');
  const messages = await OutreachMessage.find({ campaignId: campaign._id, kind: 'outreach' }).sort({ stepIndex: 1 });
  const candidates = await Candidate.find({ _id: { $in: campaign.candidateIds } }).sort({ score: -1 });
  const items = candidates
    .map((c: any) => ({
      candidate: { id: String(c._id), name: c.name, email: c.email, score: c.score, status: c.status },
      messages: messages.filter((m: any) => String(m.candidateId) === String(c._id)),
    }))
    .filter((item: any) => item.messages.length || campaign.status === 'drafting');

  const sent = messages.filter((m: any) => m.status === 'sent').length;
  res.json({ campaign, items, progress: { total: campaign.candidateIds.length, drafted: items.filter((i: any) => i.messages.length).length, failed: campaign.draftsFailed, sent } });
});

campaignsRouter.post('/campaigns/:id/approve', async (req, res) => {
  res.json(await approveCampaign(req.params.id, 'recruiter:ui'));
});

campaignsRouter.post('/campaigns/:id/pause', async (req, res) => {
  res.json(await setCampaignPaused(req.params.id, true, 'recruiter:ui'));
});

campaignsRouter.post('/campaigns/:id/resume', async (req, res) => {
  res.json(await setCampaignPaused(req.params.id, false, 'recruiter:ui'));
});
