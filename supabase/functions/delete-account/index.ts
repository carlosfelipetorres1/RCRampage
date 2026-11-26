// Permanently delete the signed-in player's account. Every game row cascades from auth.users.
import { admin, HttpError, is, serveUser, shape } from '../_shared/http.ts';

serveUser('delete-account', { rate: [3, 60] }, async ({ user, body }) => {
  shape(body, { confirm: is.oneOf(['DELETE']) });
  const { error } = await admin().auth.admin.deleteUser(user.id);
  if (error) { console.error('delete-account', error); throw new HttpError(500, 'server_error'); }
  return { deleted: true };
});
