// How many addresses one press of a send button may reach.
//
// It was 200 in three places — the guest-invite route, the gallery-link route, and the guest list
// component that tells the host "N per send" — with a comment in one of them saying the numbers
// "match" and "there is no reason for them to disagree". That is a statement of intent, not a
// mechanism: nothing stopped them drifting, and the client's copy is used to write a sentence the
// server's copy then contradicts.
//
// It lives here for the same reason the reveal constants do: both sides need it, and the honest
// place for a number both sides need is neither of them.
//
// WHY 200 rather than the whole list: a send is one HTTP request and one transaction with the mail
// transport, and a 2000-guest list (MAX_GUESTS_PER_EVENT) in one request is a request that times
// out somewhere unhelpful, having sent an unknown fraction. Two hundred goes through in seconds and
// the host is told how many are left, which is a state they can act on.
export const MAIL_BATCH_SIZE = 200;
