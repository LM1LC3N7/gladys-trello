// -----------------------------------------------------------------------------
// The texts users read at runtime (status, test button, scene actions, widget),
// in English and French. Never a key, a token or an answer body in them.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const plural = (n, one, many) => (n === 1 ? one : many);

/** The reason of a failed request, as users read it. */
export const REASONS = {
  unauthorized: both('access refused to this board (401)', 'accès refusé à ce tableau (401)'),
  forbidden: both('access refused (403)', 'accès refusé (403)'),
  not_found: both('not found (deleted or no access)', 'introuvable (supprimé ou sans accès)'),
  bad_request: both('request refused by Trello', 'requête refusée par Trello'),
  rate_limited: both('Trello asked to slow down', 'Trello a demandé de ralentir'),
  server: both('Trello server error', 'erreur du serveur Trello'),
  http: both('unexpected Trello answer', 'réponse inattendue de Trello'),
  network: both('Trello unreachable', 'Trello injoignable'),
  timeout: both('Trello did not answer in time', 'Trello n’a pas répondu à temps'),
  too_large: both('answer too large', 'réponse trop volumineuse'),
  invalid: both('unreadable answer', 'réponse illisible'),
  paused: both('paused after a Trello slow-down request', 'en pause après une demande de Trello'),
  budget: both('too many requests in 10 s', 'trop de requêtes en 10 s'),
  busy: both('Trello busy with another request', 'Trello occupé par une autre requête'),
  refused: both('credentials refused', 'identifiants refusés'),
  not_ready: both('not configured', 'non configuré'),
  stopped: both('integration stopping', 'intégration en cours d’arrêt'),
  deadline: both(
    'no time left before the scene deadline',
    'plus le temps avant la limite de la scène',
  ),
};

export const reason = (code) => REASONS[code] ?? REASONS.http;

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

export const T = {
  starting: both('Starting…', 'Démarrage…'),
  storeUnreadable: both(
    '/data cannot be read: tried again every 10 s, nothing asked to Trello meanwhile',
    '/data illisible : relu toutes les 10 s, rien n’est demandé à Trello en attendant',
  ),
  configUnread: (ms) =>
    both(
      `Configuration not read from Gladys: asked again in ${Math.ceil(ms / 1000)} s`,
      `Configuration non lue depuis Gladys : redemandée dans ${Math.ceil(ms / 1000)} s`,
    ),
  missing: both(
    'Enter the API key and the token of your Trello Power-Up',
    'Saisissez la clé d’API et le jeton de votre Power-Up Trello',
  ),
  badKey: both(
    'The API key must be 32 letters and digits (0-9, a-f): check the copy',
    'La clé d’API doit faire 32 caractères (0-9, a-f) : vérifiez la copie',
  ),
  badToken: both(
    'The token must be letters and digits only: check the copy',
    'Le jeton ne doit contenir que des lettres (a-z, A-Z) et des nombres (0-9) : vérifiez la copie',
  ),
  refused: (kind) =>
    kind === 'key'
      ? both(
          'Trello refused the API key: nothing more is asked until it changes or "Test the connection" succeeds',
          'Trello a refusé la clé d’API : plus rien n’est demandé tant qu’elle ne change pas ou que « Tester la connexion » ne réussit pas',
        )
      : both(
          'Trello refused the token (invalid, expired or revoked): nothing more is asked until it changes or "Test the connection" succeeds',
          'Trello a refusé le jeton (invalide, expiré ou révoqué) : plus rien n’est demandé tant qu’il ne change pas ou que « Tester la connexion » ne réussit pas',
        ),
  paused: (ms) =>
    both(
      `Trello asked to slow down: paused, resumes in ${minutes(ms)} min`,
      `Trello a demandé de ralentir : en pause, reprise dans ${minutes(ms)} min`,
    ),
  unreachable: (code) =>
    both(`Trello not read: ${reason(code).en}`, `Trello non lu : ${reason(code).fr}`),
  waitingFirst: both('Connected, first reading pending', 'Connecté, première lecture en attente'),
  noBoard: both(
    'No board followed: none of the boards named was found, or the account has no open board',
    'Aucun tableau suivi : aucun des tableaux indiqués n’a été trouvé, ou le compte n’a aucun tableau ouvert',
  ),
  ok: (read, total, overdue) =>
    both(
      `Connected: ${read}/${total} ${plural(total, 'board', 'boards')} read, ${overdue} overdue ${plural(overdue, 'card', 'cards')}`,
      `Connecté : ${read}/${total} ${plural(total, 'tableau lu', 'tableaux lus')}, ${overdue} ${plural(overdue, 'carte en retard', 'cartes en retard')}`,
    ),
  allFailed: (total, code) =>
    both(
      `No board could be read (${total}): ${reason(code).en}`,
      `Aucun tableau n’a pu être lu (${total}) : ${reason(code).fr}`,
    ),
  unknownBoards: (names) =>
    both(`board not found or ambiguous: ${names}`, `tableau introuvable ou ambigu : ${names}`),
  tooMany: both(
    'only the first 10 boards are followed',
    'seuls les 10 premiers tableaux sont suivis',
  ),
  cut: both(
    'a board has over 1,000 open cards: the rest is not read',
    'un tableau a plus de 1 000 cartes ouvertes : le reste n’est pas lu',
  ),
  dataError: both('/data cannot be written', '/data non inscriptible'),

  // Test button.
  testOk: (who, boards, followed, overdue, soon, hours) =>
    both(
      `Connected as ${who}: ${boards} open ${plural(boards, 'board', 'boards')}, followed: ${followed || 'none'}. Overdue cards: ${overdue}, due within ${hours} h: ${soon}.`,
      `Connecté en tant que ${who} : ${boards} ${plural(boards, 'tableau ouvert', 'tableaux ouverts')}, suivis : ${followed || 'aucun'}. Cartes en retard : ${overdue}, à échéance sous ${hours} h : ${soon}.`,
    ),
  testTooSoon: both(
    'Tested a few seconds ago: try again in 10 s',
    'Testé il y a quelques secondes : réessayez dans 10 s',
  ),
  testFailed: (code) =>
    both(`Test failed: ${reason(code).en}`, `Échec du test : ${reason(code).fr}`),

  // Scene actions: what was done or not, never a "success" that is not one.
  nothingSent: (why) => `Nothing sent to Trello: ${why}`,
  refusedByTrello: (why) => `Trello refused the request: ${why}`,
  boardNotFound: (ref, error) =>
    error === 'ambiguous'
      ? `several boards are named "${ref}": use its link or short link`
      : `no open board "${ref}" for this account`,
  listNotFound: (ref, error) =>
    error === 'ambiguous'
      ? `several lists are named "${ref}" on this board`
      : `no open list "${ref}" on this board`,
  cardNotFound: (ref, error) =>
    error === 'ambiguous'
      ? `several cards match "${ref}": use its link or a more precise name`
      : `no open card matches "${ref}" on this board`,
  badDue: 'the due delay must be a whole number of minutes, 0 to 525600',
  emptyName: 'the card name is empty',
  notRead: 'no board read yet (first reading pending)',

  // Widget.
  widgetOverdue: both('Overdue', 'En retard'),
  widgetSoon: both('Due soon', 'Bientôt dues'),
  widgetNone: (hours) =>
    both(
      `No card overdue or due within ${hours} h`,
      `Aucune carte en retard ni à échéance sous ${hours} h`,
    ),
  widgetNotRead: both('Trello not read yet', 'Trello pas encore lu'),
  widgetDue: both('Due', 'Échéance'),
  widgetOpen: both('Open in Trello', 'Ouvrir dans Trello'),
};
