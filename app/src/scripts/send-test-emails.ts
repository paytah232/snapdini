// Sends the lifecycle emails to one or more addresses for review, using sample data.
// Run inside the app container with a DELIVERING Mailgun config (prod domain), e.g.:
//   docker exec -e MAILGUN_API_KEY=... -e MAILGUN_DOMAIN=mg.snapdini.com \
//     -e "SMTP_FROM=Snapdini <support@snapdini.com>" snapdini-dev-app \
//     npx tsx src/scripts/send-test-emails.ts you@example.com
// Subjects are prefixed [TEST]. Replies route to support@snapdini.com.
import { sendMail } from '../server/email';
import { welcomeEmail, checkinEmail, surveyEmail, accountWelcomeEmail, activationNudgeEmail, type LifecycleView } from '../server/lifecycle-emails';

const recipients = process.argv.slice(2).filter(Boolean);
if (!recipients.length) { console.error('usage: send-test-emails.ts <to> [to2 ...]'); process.exit(1); }

const BASE = process.env.BASE_URL || 'https://snapdini.com';
const sample: LifecycleView = {
  ownerName: 'Alex',
  eventName: 'The Sample Wedding',
  guestCap: 150,
  shotsPerGuest: 24,
  framesAll: true,
  hasVideo: false,
  videoSeconds: 0,
  revealMode: 'manual',
  retentionDays: 7,
  datesLabel: 'Sat 24 – Mon 26 Oct 2026',
  manageUrl: `${BASE}/admin/SAMPLE01`,
  surveyUrl: process.env.SURVEY_URL || `${BASE}/survey/sample-token`,
  unsubUrl: `${BASE}/email/unsubscribe/sample-token`,
};

// Short-notice variant so both welcome flavours can be reviewed side by side.
const soon: LifecycleView = { ...sample, eventName: 'Sarah & Tom — Engagement', datesLabel: 'this Saturday', startsSoon: true };

const acct = { ownerName: 'Alex', createUrl: `${BASE}/app`, unsubUrl: `${BASE}/email/unsubscribe/sample` };

const builds = [
  { kind: 'account-welcome', ...accountWelcomeEmail(acct) },
  { kind: 'activation-nudge', ...activationNudgeEmail(acct) },
  { kind: 'welcome', ...welcomeEmail(sample) },
  { kind: 'welcome (short-notice)', ...welcomeEmail(soon) },
  { kind: 'check-in', ...checkinEmail(sample) },
  { kind: 'survey', ...surveyEmail(sample) },
];

(async () => {
  for (const to of recipients) {
    for (const b of builds) {
      try {
        await sendMail({ to, subject: `[TEST] ${b.subject}`, html: b.html, replyTo: 'support@snapdini.com' });
        console.log(`✓ sent ${b.kind} → ${to}`);
      } catch (e) {
        console.error(`✗ failed ${b.kind} → ${to}: ${(e as Error).message}`);
      }
    }
  }
  console.log('done.');
  process.exit(0);
})();
