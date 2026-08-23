// Sends the two operator (support@) notification emails for review: an "unhappy survey" instant
// alert and a forced daily-digest preview (reflects current DB state). Run in the app container with
// OPS_NOTIFICATIONS=1, SUPPORT_EMAIL=<recipient>, and a delivering Mailgun config, e.g.:
//   docker exec -e OPS_NOTIFICATIONS=1 -e SUPPORT_EMAIL=you@example.com \
//     -e MAILGUN_API_KEY=... -e MAILGUN_DOMAIN=mg.snapdini.com \
//     -e "SMTP_FROM=Snapdini <support@snapdini.com>" snapdini-dev-app \
//     npx tsx src/scripts/send-ops-test.ts
import { notifyUnhappySurvey, sendDigestPreview } from '../server/ops-notify';

(async () => {
  await notifyUnhappySurvey(
    { name: 'The Sample Wedding', joinCode: 'SAMPLE01' },
    { overall: 2, setup: 3, guestExperience: 2, value: 2, nps: 4,
      comments: JSON.stringify({ overall: 'The QR was confusing for some older guests.', improve: 'Clearer on-table instructions would help.' }),
      contactOptIn: true },
  );
  console.log('✓ sent unhappy-survey alert');
  await sendDigestPreview();
  console.log('✓ sent daily-digest preview');
  process.exit(0);
})();
