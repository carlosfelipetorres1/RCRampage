// Read the signed-in player's state, set the display name, or pick the truck or skin.
import { HttpError, is, rpc, serveUser, shape } from '../_shared/http.ts';
import { forClient, loadState, R } from '../_shared/game.ts';

const RESERVED = ['admin', 'moderator', 'mod', 'support', 'staff', 'official', 'system', 'rcrampage', 'rc rampage', 'null', 'undefined', 'anonymous', 'guest'];
// Deliberately short: catches the obvious, a moderator handles the rest via the `banned` flag.
const BLOCKED = ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'nazi', 'hitler', 'whore', 'slut', 'puta', 'mierda', 'pendej', 'kurwa'];

function cleanName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z0-9_ -]{3,16}$/.test(name)) throw new HttpError(400, 'bad_name');
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's');
  if (RESERVED.includes(name.toLowerCase()) || BLOCKED.some((w) => flat.includes(w))) throw new HttpError(400, 'name_not_allowed');
  return name;
}

serveUser('profile', { rate: [60, 60] }, async ({ user, body }) => {
  const b = shape<{ action: string; name?: string; truck?: string; skin?: string }>(body, {
    action: is.oneOf(['get', 'name', 'truck', 'skin']),
    name: is.str(40),
    truck: is.oneOf(R.TRUCK_IDS),
    skin: is.oneOf(R.SKIN_IDS),
  }, ['name', 'truck', 'skin']);

  if (b.action === 'name') {
    if (b.name === undefined) throw new HttpError(400, 'missing_field');
    await rpc('rc_set_name', { p_uid: user.id, p_name: cleanName(b.name) });
  } else if (b.action === 'truck') {
    if (b.truck === undefined) throw new HttpError(400, 'missing_field');
    await rpc('rc_set_truck', { p_uid: user.id, p_truck: b.truck });
  } else if (b.action === 'skin') {
    if (b.skin === undefined) throw new HttpError(400, 'missing_field');
    await rpc('rc_set_skin', { p_uid: user.id, p_skin: b.skin });
  }
  return { state: forClient(await loadState(user.id)) };
});
