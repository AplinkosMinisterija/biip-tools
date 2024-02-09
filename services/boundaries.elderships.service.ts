'use strict';

import moleculer from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';

import PostgisMixin from 'moleculer-postgis';
import { boundariesConfig } from '../knexfile';

@Service({
  name: 'boundaries.elderships',

  mixins: [
    DbConnection({
      collection: 'elderships',
      config: boundariesConfig,
      rest: '/boundaries/elderships',
      createActions: {
        create: false,
        update: false,
        remove: false,
        get: false,
        createMany: false,
        removeAllEntities: false,
      },
    }),
    PostgisMixin({
      srid: 3346,
    }),
  ],

  settings: {
    fields: {
      id: {
        type: 'string',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },

      geom: {
        type: 'any',
        geom: {
          type: 'geom',
        },
      },

      email: 'string',
      name: 'string',
    },
  },
})
export default class BoundariesEldershipsService extends moleculer.Service {}
