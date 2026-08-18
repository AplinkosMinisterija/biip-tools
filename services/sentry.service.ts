// @ts-ignore
import SentryMixin from 'moleculer-sentry';
import moleculer, { Errors } from 'moleculer';
import { Method, Service } from 'moleculer-decorators';
import { Integrations } from '@sentry/node';

@Service({
  mixins: [SentryMixin],

  settings: {
    /** @type {Object?} Sentry configuration wrapper. */
    sentry: {
      /** @type {String} DSN given by sentry. */
      dsn: process.env.SENTRY_DSN,
      /** @type {String} Name of event fired by "Event" exported in tracing. */
      tracingEventName: '$tracing.spans',
      /** @type {Object} Additional options for `Sentry.init`. */
      options: {
        environment: process.env.ENVIRONMENT,
        release: process.env.VERSION,
        tracesSampleRate: 1,
        // Disable the bundled Undici integration: @sentry/node 7.61.0's
        // `setHeadersOnRequest` calls `request.headers.split()`, which
        // crashes on newer Node 20 / undici where `request.headers` is an
        // Array rather than a string. Every fetch() from this process
        // (e.g. /tools/pdf → chrome) was triggering the crash, taking the
        // whole tools container down on every PDF request. We keep the
        // other default integrations (InboundFilters, FunctionToString,
        // ConsoleBreadcrumbs, etc) plus our explicit Http/Postgres.
        integrations: (defaultIntegrations: any[]) => [
          ...defaultIntegrations.filter((i) => i.name !== 'Undici'),
          new Integrations.Http({ tracing: true }),
          new Integrations.Postgres(),
        ],
      },
      /** @type {String?} Name of the meta containing user infos. */
      userMetaKey: 'user',
    },
  },
})
export default class SentryService extends moleculer.Service {
  @Method
  shouldReport({ error }: { error: Errors.MoleculerError }): boolean {
    // Skip 4xx client errors — normal traffic, not server bugs
    if ([401, 404].includes(error?.code)) {
      return false;
    }

    return true;
  }
}
