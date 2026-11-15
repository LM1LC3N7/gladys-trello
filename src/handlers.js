// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container. Every handler is registered
// before connect().
// -----------------------------------------------------------------------------

import { ACTION_TEST, SCENE_CREATE, SCENE_GET, SCENE_MOVE, WIDGET_CARDS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Configuration screen button.
  gladys.onAction(ACTION_TEST, () => app.testConnection());

  // Configuration saved by the administrator: new credentials are tried at once.
  gladys.onConfigUpdated((config) => app.configure(config));

  // Scene actions (the core gives each its timeout_seconds; the app answers within 25 s).
  gladys.onSceneAction(SCENE_CREATE, (fields) => app.createCard(fields));
  gladys.onSceneAction(SCENE_MOVE, (fields) => app.moveCard(fields));
  gladys.onSceneAction(SCENE_GET, (fields) => app.getCards(fields));

  // Dashboard widget (read only, from the last readings: no request).
  gladys.onWidgetGet(WIDGET_CARDS, (request) => app.getWidget(request));

  // Every connection (the first one and each reconnection): /data once, the
  // configuration read again (retried for ever), the schedule kept.
  gladys.on('connected', async () => {
    try {
      await app.connected();
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
  gladys.on('disconnected', () => {
    app.stop().catch((err) => logger?.error(`Stop failed (${err?.name ?? 'Error'})`));
  });
  gladys.handleShutdown(() => app.stop());
}
