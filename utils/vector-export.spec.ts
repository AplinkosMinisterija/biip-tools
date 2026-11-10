import { execFileSync } from 'child_process';
import { createWriteStream, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import {
  GPKG_FORMAT,
  MAX_LAYERS,
  MAX_TOTAL_FEATURES,
  resolveVectorExportLayers,
  runVectorExport,
  SHP_FORMAT,
  VectorExportFormat,
  VectorExportLayer,
} from './vector-export';

const featureCollection = (featureCount = 1) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: featureCount }, () => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {},
  })),
});

const layer = (name: string, featureCount = 1): VectorExportLayer => ({
  name,
  geojson: featureCollection(featureCount),
});

// Layers share one FeatureCollection instance so a large count stays cheap —
// resolveVectorExportLayers only reads features.length.
const manyLayers = (count: number, featureCount = 1): VectorExportLayer[] => {
  const geojson = featureCollection(featureCount);
  return Array.from({ length: count }, (_, i) => ({ name: `layer_${i}`, geojson }));
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e: any) {
    return e.type;
  }
  return undefined;
};

describe('resolveVectorExportLayers', () => {
  describe('input shapes', () => {
    it('wraps single-layer `geojson` into one layer named after the export', () => {
      expect(resolveVectorExportLayers({ geojson: featureCollection(), name: 'extract' })).toEqual([
        { name: 'extract', geojson: featureCollection() },
      ]);
    });

    it('passes `layers` through untouched', () => {
      const layers = [layer('places'), layer('observations')];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toBe(layers);
    });

    it('prefers `layers` when both shapes are supplied', () => {
      const layers = [layer('places')];
      expect(
        resolveVectorExportLayers({ layers, geojson: featureCollection(), name: 'extract' }),
      ).toBe(layers);
    });

    it('rejects a request with neither shape', () => {
      expect(codeOf(() => resolveVectorExportLayers({ name: 'extract' }))).toBe('NO_INPUT');
    });

    it('rejects an empty layers array', () => {
      expect(codeOf(() => resolveVectorExportLayers({ layers: [], name: 'extract' }))).toBe(
        'NO_INPUT',
      );
    });
  });

  describe('geojson validation', () => {
    it('rejects a layer whose geojson is not a FeatureCollection', () => {
      const layers = [{ name: 'places', geojson: { type: 'Feature' } }];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'INVALID_GEOJSON',
      );
    });

    it('rejects a layer with no features', () => {
      expect(
        codeOf(() => resolveVectorExportLayers({ layers: [layer('places', 0)], name: 'x' })),
      ).toBe('EMPTY_FEATURES');
    });
  });

  describe('resource limits', () => {
    it('accepts exactly MAX_LAYERS', () => {
      const layers = manyLayers(MAX_LAYERS);
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(MAX_LAYERS);
    });

    it('rejects MAX_LAYERS + 1 — each layer costs one GDAL process', () => {
      const layers = manyLayers(MAX_LAYERS + 1);
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_LAYERS',
      );
    });

    it('accepts exactly MAX_TOTAL_FEATURES', () => {
      const layers = [layer('places', MAX_TOTAL_FEATURES)];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(1);
    });

    it('rejects MAX_TOTAL_FEATURES + 1', () => {
      const layers = [layer('places', MAX_TOTAL_FEATURES + 1)];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_FEATURES',
      );
    });

    it('counts features across layers, not per layer', () => {
      const half = Math.ceil(MAX_TOTAL_FEATURES / 2) + 1;
      const layers = [layer('a', half), layer('b', half)];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'TOO_MANY_FEATURES',
      );
    });
  });

  describe('duplicate layer names', () => {
    it('rejects an exact duplicate', () => {
      const layers = [layer('places'), layer('places')];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'DUPLICATE_LAYER',
      );
    });

    // GPKG layer names become SQLite table names and SQLite identifiers are
    // case-insensitive, so these two would silently merge into one table.
    it('rejects a case-only duplicate', () => {
      const layers = [layer('roads'), layer('Roads')];
      expect(codeOf(() => resolveVectorExportLayers({ layers, name: 'extract' }))).toBe(
        'DUPLICATE_LAYER',
      );
    });

    it('allows names that differ by more than case', () => {
      const layers = [layer('roads'), layer('roads_2')];
      expect(resolveVectorExportLayers({ layers, name: 'extract' })).toHaveLength(2);
    });
  });
});

const hasOgr = (() => {
  try {
    execFileSync('ogr2ogr', ['--version'], { stdio: 'ignore' });
    execFileSync('zip', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The pipeline shells out to GDAL; the guardrail tests above must still run on
// a machine without it.
const describeIfOgr = hasOgr ? describe : describe.skip;

const polygonFC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [500000, 6000000],
              [500010, 6000000],
              [500010, 6000010],
              [500000, 6000000],
            ],
          ],
        ],
      },
      properties: { placeId: 12, placeCode: 'SRIS-12', placeCreatedAt: '2024-03-01' },
    },
  ],
};

const pointFC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'MultiPoint', coordinates: [[500005, 6000005]] },
      properties: { formId: 77, observedAt: '2024-04-02' },
    },
  ],
};

const twoLayers: VectorExportLayer[] = [
  {
    name: 'Radavietes',
    geojson: polygonFC,
    fields: [
      { name: 'placeId', shortName: 'RADAV_ID', type: 'Integer', alias: 'Radavietės ID' },
      { name: 'placeCode', shortName: 'RADAV_KOD', type: 'String', alias: 'Radavietės kodas' },
      { name: 'placeCreatedAt', shortName: 'SUKURTA', type: 'Date', alias: 'Sukūrimo data' },
    ],
  },
  {
    name: 'Stebejimai',
    geojson: pointFC,
    fields: [
      { name: 'formId', shortName: 'ANKET_ID', type: 'Integer', alias: 'Anketos ID' },
      { name: 'observedAt', shortName: 'STEB_DATA', type: 'Date', alias: 'Stebėta' },
    ],
  },
];

const exportTo = async (format: VectorExportFormat, dir: string) => {
  const { stream, filename, size, contentType } = await runVectorExport({
    layers: twoLayers,
    name: 'israsas-1',
    srid: 3346,
    format,
  });

  const target = join(dir, filename);
  await pipeline(stream, createWriteStream(target));

  return { target, filename, size, contentType };
};

const fieldNamesOf = (dataset: string, layer: string) =>
  execFileSync('ogrinfo', ['-so', dataset, layer], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.match(/^(\w+): (String|Integer|Integer64|Real|Date|DateTime)/)?.[1])
    .filter((name): name is string => !!name);

describeIfOgr('runVectorExport', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(tmpdir(), 'vector-export-spec-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('packages one shapefile per layer into a zip named after the export', async () => {
    const { target, filename, size, contentType } = await exportTo(SHP_FORMAT, dir);

    expect(filename).toBe('israsas-1.zip');
    expect(contentType).toBe('application/zip');
    expect(size).toBeGreaterThan(0);

    const entries = execFileSync('unzip', ['-Z1', target], { encoding: 'utf8' }).split('\n');
    expect(entries).toContain('israsas-1/Radavietes.shp');
    expect(entries).toContain('israsas-1/Stebejimai.shp');
    expect(entries).toContain('israsas-1/Radavietes.dbf');
    expect(entries).toContain('israsas-1/Radavietes.prj');
  });

  it('renames shapefile fields to their shortName — DBF caps a name at 10 characters', async () => {
    const { target } = await exportTo(SHP_FORMAT, dir);
    execFileSync('unzip', ['-q', target, '-d', dir]);

    expect(fieldNamesOf(join(dir, 'israsas-1', 'Radavietes.shp'), 'Radavietes')).toEqual([
      'RADAV_ID',
      'RADAV_KOD',
      'SUKURTA',
    ]);
    expect(fieldNamesOf(join(dir, 'israsas-1', 'Stebejimai.shp'), 'Stebejimai')).toEqual([
      'ANKET_ID',
      'STEB_DATA',
    ]);
  });

  it('keeps the full field names in a geopackage holding every layer', async () => {
    const { target, filename, contentType } = await exportTo(GPKG_FORMAT, dir);

    expect(filename).toBe('israsas-1.gpkg');
    expect(contentType).toBe('application/geopackage+sqlite3');
    expect(fieldNamesOf(target, 'Radavietes')).toEqual(['placeId', 'placeCode', 'placeCreatedAt']);
    expect(fieldNamesOf(target, 'Stebejimai')).toEqual(['formId', 'observedAt']);
  });
});
