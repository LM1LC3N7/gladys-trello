// -----------------------------------------------------------------------------
// The "cards" dashboard widget (pure): two tiles (overdue, due soon) and the
// cards themselves, overdue first then by due date, each opening its Trello
// card. Read only: no button acts on Trello from the dashboard.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { WIDGET_ITEMS } from './constants.js';

const SUBTITLE_MAX = 60;
import { T } from './i18n.js';
import { cutText, isOverdue, isSoon } from './trello.js';

const pick = (text, language) => (language === 'fr' ? text.fr : text.en);

const LOCALES = { fr: 'fr-FR', en: 'en-GB', iso: 'sv-SE' };

/** "15/11/2026 18:00" (fr), "15/11/2026, 18:00" (en), "2026-11-15 18:00" (iso) in the zone. */
export function formatDue(ms, timeZone, language) {
  if (ms === null || ms === undefined) return '';
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** A short due for a badge (≤ 16 characters): "18:00" today, else "15/11 18:00". */
function shortDue(ms, now, timeZone, language) {
  const day = (t) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(new Date(t));
  const time = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
  if (day(ms) === day(now)) return time;
  const date = new Intl.DateTimeFormat(language === 'fr' ? 'fr-FR' : 'en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(ms));
  return `${date} ${time}`.slice(0, 16);
}

/**
 * The cards of `boards` overdue or due within `soonMs`, overdue first, then by
 * due date: `[{ board, card, overdue }]`.
 */
export function dueCards(boards, now, soonMs, { list } = {}) {
  const out = [];
  for (const board of boards) {
    for (const card of board.cards.values()) {
      if (list && card.idList !== list) continue;
      const overdue = isOverdue(card, now);
      if (overdue || isSoon(card, now, soonMs)) out.push({ board, card, overdue });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      a.card.due - b.card.due ||
      (a.card.id < b.card.id ? -1 : 1),
  );
}

const chars = cutText;

/** "Board · List" in the 60 characters the core keeps: the board shortened first. */
export function subtitleOf(board, list) {
  const sep = ' · ';
  const whole = `${board}${sep}${list}`;
  if (whole.length <= SUBTITLE_MAX) return whole;
  const listPart = chars(list, SUBTITLE_MAX - sep.length - 8);
  const room = SUBTITLE_MAX - sep.length - listPart.length;
  return `${chars(board, room)}${sep}${listPart}`;
}

/** A widget showing only a text (not configured, not read yet). */
export const messageWidget = (text, language) => ({
  ttl_seconds: 60,
  components: [{ type: 'text', variant: 'body', text: pick(text, language).slice(0, 300) }],
});

export function cardsWidget({ boards, now, soonHours, timeZone, language }) {
  const items = dueCards(boards, now, soonHours * 3_600_000);
  const overdue = items.filter((i) => i.overdue).length;
  const soon = items.length - overdue;
  const components = [
    {
      type: 'value',
      value: overdue,
      label: pick(T.widgetOverdue, language),
      icon: 'alert-circle',
      color: overdue > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: soon,
      label: pick(T.widgetSoon, language),
      icon: 'clock',
      color: soon > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (items.length === 0) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(T.widgetNone(soonHours), language),
    });
    return { ttl_seconds: 60, components };
  }
  components.push({
    type: 'card-list',
    display: 'list',
    items: items.slice(0, WIDGET_ITEMS).map(({ board, card, overdue: late }) => {
      const list = board.lists.get(card.idList) ?? '';
      const item = {
        title: chars(card.name, 60),
        subtitle: subtitleOf(board.name, list),
        badge: {
          text: late
            ? pick(T.widgetOverdue, language).slice(0, 16)
            : shortDue(card.due, now, timeZone, language),
          color: late ? WIDGET_COLORS.DANGER : WIDGET_COLORS.WARNING,
        },
        description:
          `${pick(T.widgetDue, language)}${language === 'fr' ? ' : ' : ': '}${formatDue(card.due, timeZone, language)}${
            card.labels ? `\n${card.labels}` : ''
          }`.slice(0, 2000),
      };
      if (card.url) item.links = [{ url: card.url, label: pick(T.widgetOpen, language) }];
      return item;
    }),
  });
  return { ttl_seconds: 60, components };
}
