// Name a lens the way a person would, but ONLY when the device actually told us what it is.
//
// There is no standard API for lens role: getCapabilities() reports zoom and resolution, never focal
// length or "this is the telephoto". What differs is the LABEL. iOS Safari is genuinely descriptive
// ("Back Ultra Wide Camera", "Back Telephoto Camera"), and most desktop cameras name themselves
// usefully. Android Chrome typically says "camera2 0, facing back", which carries no lens
// information at all — and the only way to infer it there is to open every lens in turn and compare
// fields of view, which is slow, visible, and fails on some devices.
//
// So: translate a label that means something, and fall back to a plain numbered name otherwise. A
// confidently wrong "Telephoto" is worse than "Back camera 2", especially on a device whose lenses
// we already know misbehave.
export function lensName(rawLabel: string, i: number, total: number): string {
  const l = (rawLabel || '').trim();
  if (!l) return total > 1 ? `Camera ${i + 1}` : 'Camera';
  const back = /back|rear|environment|world/i.test(l);
  const front = /front|user|selfie|face/i.test(l);
  const side = back ? 'Back' : front ? 'Front' : '';
  if (/ultra.?wide/i.test(l)) return side ? `${side} ultra-wide` : 'Ultra-wide';
  if (/telephoto|tele\b/i.test(l)) return side ? `${side} telephoto` : 'Telephoto';
  if (/dual.?wide|triple/i.test(l)) return side ? `${side} wide` : 'Wide';
  if (/\bwide\b/i.test(l)) return side ? `${side} wide` : 'Wide';
  if (/\bdual\b/i.test(l)) return side ? `${side} dual` : 'Dual';
  // A label that names a side but nothing else still beats "Camera 3".
  if (side && /camera2|facing|^\s*camera\b/i.test(l)) return total > 2 ? `${side} camera ${i + 1}` : `${side} camera`;
  if (side && l.length > 28) return total > 2 ? `${side} camera ${i + 1}` : `${side} camera`;
  return l;   // a real, human name the device gave us — keep it
}
