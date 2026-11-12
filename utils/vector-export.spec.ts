import { Errors } from 'moleculer';
import Validator from 'fastest-validator';
import { execFileSync } from 'child_process';
import { createWriteStream, promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { pipeline } from 'stream/promises';
import {
  VectorExportFeatureCollection,
  MAX_FIELDS,
  vectorExportParams,
  GPKG_FORMAT,
  MAX_LAYERS,
  MAX_TOTAL_FEATURES,
  resolveVectorExportLayers,
  runVectorExport,
  SHP_FORMAT,
  sweepAbandonedStream,
  DOWNLOAD_IDLE_SWEEP_MS,
  DOWNLOAD_MAX_MS,
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
  } catch (e) {
    return (e as Errors.MoleculerError).type;
  }
  return undefined;
};

describe('vectorExportParams', () => {
  const validator = new Validator();
  const check = validator.compile({ ...vectorExportParams, $$strict: false });

  const layerWith = (over: Record<string, unknown>) => ({
    name: 'israsas-1',
    srid: 3346,
    layers: [{ name: 'Radavietes', geojson: polygonFC, ...over }],
  });

  const errorsOf = (params: unknown) => {
    const result = check(params as Record<string, unknown>);
    return Array.isArray(result) ? result.map((e) => `${e.field}:${e.type}`) : [];
  };

  it('accepts the payload the API sends', () => {
    expect(errorsOf({ name: 'israsas-1', srid: 3346, layers: twoLayers })).toEqual([]);
  });

  it('accepts exactly MAX_FIELDS fields', () => {
    const fields = Array.from({ length: MAX_FIELDS }, (_, i) => ({ name: `f${i}` }));

    expect(errorsOf(layerWith({ fields }))).toEqual([]);
  });

  it('rejects MAX_FIELDS + 1 — every field becomes a column in the VRT', () => {
    const fields = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({ name: `f${i}` }));

    expect(errorsOf(layerWith({ fields }))).toEqual(['layers[0].fields:arrayMax']);
  });

  it('rejects a control character in a field name — libxml recovers and renames the column', () => {
    expect(errorsOf(layerWith({ fields: [{ name: 'place\u0001Id' }] }))).toEqual([
      'layers[0].fields[0].name:stringPattern',
    ]);
  });

  it('rejects an srid that is not a whole EPSG code', () => {
    expect(errorsOf({ name: 'israsas-1', srid: 0.5, layers: twoLayers })).toEqual([
      'srid:numberMin',
      'srid:numberInteger',
    ]);
  });
});

describe('resolveVectorExportLayers', () => {
  describe('input shapes', () => {
    it('wraps single-layer `geojson` into one layer named after the export', () => {
      expect(resolveVectorExportLayers({ geojson: featureCollection(), name: 'extract' })).toEqual([
        { name: 'extract', geojson: featureCollection() },
      ]);
    });

    it('sanitises the export name when it becomes the single layer name', () => {
      // `name` is also a filename, so it allows dots a layer name cannot keep.
      const [layer] = resolveVectorExportLayers({ geojson: polygonFC, name: 'israsas.1-v2' });

      expect(layer.name).toBe('israsas_1_v2');
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

  describe('url layers', () => {
    const SOURCE = 'https://s3.example.lt/tmp/Upes.geojson';

    beforeEach(() => {
      process.env.VECTOR_EXPORT_SOURCE_HOSTS = 's3.example.lt';
    });
    afterEach(() => {
      delete process.env.VECTOR_EXPORT_SOURCE_HOSTS;
    });

    it('accepts a layer given as a url', () => {
      const layers = resolveVectorExportLayers({
        layers: [{ name: 'Upes', url: SOURCE }],
        name: 'israsas-1',
      });

      expect(layers).toEqual([{ name: 'Upes', url: SOURCE }]);
    });

    it('rejects a layer that carries both geojson and url', () => {
      expect(() =>
        resolveVectorExportLayers({
          layers: [{ name: 'Upes', geojson: polygonFC, url: SOURCE }],
          name: 'israsas-1',
        }),
      ).toThrow(expect.objectContaining({ type: 'LAYER_INPUT_AMBIGUOUS' }));
    });

    it('rejects a layer with neither geojson nor url', () => {
      expect(() =>
        resolveVectorExportLayers({ layers: [{ name: 'Upes' }], name: 'israsas-1' }),
      ).toThrow(expect.objectContaining({ type: 'INVALID_GEOJSON' }));
    });

    it('rejects a url whose host is not allowlisted', () => {
      expect(() =>
        resolveVectorExportLayers({
          layers: [{ name: 'Upes', url: 'https://evil.example/a.geojson' }],
          name: 'israsas-1',
        }),
      ).toThrow(expect.objectContaining({ type: 'URL_HOST_NOT_ALLOWED' }));
    });

    it('rejects every url when no allowlist is configured', () => {
      delete process.env.VECTOR_EXPORT_SOURCE_HOSTS;

      expect(() =>
        resolveVectorExportLayers({ layers: [{ name: 'Upes', url: SOURCE }], name: 'israsas-1' }),
      ).toThrow(expect.objectContaining({ type: 'URL_HOST_NOT_ALLOWED' }));
    });

    it('counts the features of inline layers only', () => {
      const inline = {
        name: 'Stebejimai',
        geojson: {
          type: 'FeatureCollection',
          features: new Array(MAX_TOTAL_FEATURES).fill(polygonFC.features[0]),
        } as VectorExportFeatureCollection,
      };

      expect(
        resolveVectorExportLayers({
          layers: [{ name: 'Upes', url: SOURCE }, inline],
          name: 'israsas-1',
        }),
      ).toHaveLength(2);
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

const featureCountOf = (dataset: string, layer: string) =>
  Number(
    execFileSync('ogrinfo', ['-so', dataset, layer], { encoding: 'utf8' }).match(
      /Feature Count: (\d+)/,
    )?.[1],
  );

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

  it('packages the shapefiles at the archive root, so the zip itself opens as a dataset', async () => {
    const { target, filename, size, contentType } = await exportTo(SHP_FORMAT, dir);

    expect(filename).toBe('israsas-1.zip');
    expect(contentType).toBe('application/zip');
    expect(size).toBeGreaterThan(0);

    const entries = execFileSync('unzip', ['-Z1', target], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(entries).toEqual(
      expect.arrayContaining([
        'Radavietes.shp',
        'Radavietes.dbf',
        'Radavietes.prj',
        'Stebejimai.shp',
      ]),
    );
    expect(entries.filter((entry) => entry.includes('/'))).toEqual([]);
    expect(featureCountOf(`/vsizip/${target}`, 'Radavietes')).toBe(1);
  });

  it('ships a QGIS style beside each shapefile, so a sub-pixel hull still shows up', async () => {
    const { target } = await exportTo(SHP_FORMAT, dir);
    execFileSync('unzip', ['-q', target, '-d', dir]);

    const places = await fsp.readFile(join(dir, 'Radavietes.qml'), 'utf8');
    const observations = await fsp.readFile(join(dir, 'Stebejimai.qml'), 'utf8');

    expect(places).toContain('<symbol type="fill"');
    expect(places).toContain('class="CentroidFill"');
    expect(places).toContain('<layerGeometryType>2</layerGeometryType>');
    expect(observations).toContain('<symbol type="marker"');
    expect(observations).not.toContain('CentroidFill');
    expect(observations).toContain('<layerGeometryType>0</layerGeometryType>');
  });

  it('renames shapefile fields to their shortName — DBF caps a name at 10 characters', async () => {
    const { target } = await exportTo(SHP_FORMAT, dir);
    execFileSync('unzip', ['-q', target, '-d', dir]);

    expect(fieldNamesOf(join(dir, 'Radavietes.shp'), 'Radavietes')).toEqual([
      'RADAV_ID',
      'RADAV_KOD',
      'SUKURTA',
    ]);
    expect(fieldNamesOf(join(dir, 'Stebejimai.shp'), 'Stebejimai')).toEqual([
      'ANKET_ID',
      'STEB_DATA',
    ]);
  });

  it('ignores a `name` member in the posted FeatureCollection', async () => {
    // Most GeoJSON writers emit one, and GDAL names the source layer after it.
    const layers: VectorExportLayer[] = [
      {
        name: 'Radavietes',
        geojson: { ...polygonFC, name: 'visai_kitas_vardas' } as VectorExportFeatureCollection,
        fields: [
          { name: 'placeId', shortName: 'RADAV_ID', type: 'Integer', alias: 'Radavietės ID' },
        ],
      },
    ];

    const { stream, filename } = await runVectorExport({
      layers,
      name: 'israsas-1',
      srid: 3346,
      format: GPKG_FORMAT,
    });

    const target = join(dir, filename);
    await pipeline(stream, createWriteStream(target));

    const info = execFileSync('ogrinfo', ['-so', target, 'Radavietes'], { encoding: 'utf8' });
    expect(info).toContain('Feature Count: 1');
  });

  it('fails when ogr2ogr reports an error on stderr but still exits 0', async () => {
    // A rename is the one case with an explicit VRT `src`, which GDAL errors on.
    const layers: VectorExportLayer[] = [
      {
        name: 'Radavietes',
        geojson: polygonFC,
        fields: [
          { name: 'placeId', shortName: 'RADAV_ID', type: 'Integer', alias: 'Radavietės ID' },
          { name: 'noSuchField', shortName: 'NEBE', type: 'String', alias: 'Nėra tokio' },
        ],
      },
    ];

    await expect(
      runVectorExport({ layers, name: 'israsas-1', srid: 3346, format: SHP_FORMAT }),
    ).rejects.toMatchObject({ type: 'OGR2OGR_FAILED' });
  });

  describeIfOgr('a layer fetched from a url', () => {
    let server: Server;
    let origin: string;
    let body: string;
    let contentType: string;

    beforeEach(async () => {
      body = JSON.stringify(polygonFC);
      contentType = 'application/geo+json';
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
      process.env.VECTOR_EXPORT_SOURCE_HOSTS = `127.0.0.1:${port}`;
    });

    afterEach(async () => {
      delete process.env.VECTOR_EXPORT_SOURCE_HOSTS;
      delete process.env.VECTOR_EXPORT_MAX_SOURCE_BYTES;
      delete process.env.VECTOR_EXPORT_SOURCE_IDLE_MS;
      await new Promise((resolve) => server.close(resolve));
    });

    const exportUrlLayer = async (format: VectorExportFormat) => {
      const { stream, filename } = await runVectorExport({
        layers: [
          {
            name: 'Radavietes',
            url: `${origin}/Radavietes.geojson`,
            fields: [{ name: 'placeId', shortName: 'RADAV_ID', type: 'Integer' }],
          },
        ],
        name: 'israsas-1',
        srid: 3346,
        format,
      });
      const target = join(dir, filename);
      await pipeline(stream, createWriteStream(target));
      return target;
    };

    it('produces the same dataset as the identical inline layer', async () => {
      const fromUrl = await exportUrlLayer(GPKG_FORMAT);

      const { stream } = await runVectorExport({
        layers: [
          {
            name: 'Radavietes',
            geojson: polygonFC,
            fields: [{ name: 'placeId', shortName: 'RADAV_ID', type: 'Integer' }],
          },
        ],
        name: 'inline-1',
        srid: 3346,
        format: GPKG_FORMAT,
      });
      const inline = join(dir, 'inline-1.gpkg');
      await pipeline(stream, createWriteStream(inline));

      expect(fieldNamesOf(fromUrl, 'Radavietes')).toEqual(fieldNamesOf(inline, 'Radavietes'));
      expect(featureCountOf(fromUrl, 'Radavietes')).toBe(featureCountOf(inline, 'Radavietes'));
    });

    it('gives up on a source that accepts the connection and never answers', async () => {
      process.env.VECTOR_EXPORT_SOURCE_IDLE_MS = '150';
      await new Promise((resolve) => server.close(resolve));
      // Accepts the socket and holds it: without an idle timeout the export never settles.
      server = createServer(() => undefined);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
      process.env.VECTOR_EXPORT_SOURCE_HOSTS = `127.0.0.1:${port}`;

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toMatchObject({
        type: 'SOURCE_FETCH_FAILED',
      });
    });

    it('gives up on a source that answers and then stalls mid-body', async () => {
      process.env.VECTOR_EXPORT_SOURCE_IDLE_MS = '150';
      await new Promise((resolve) => server.close(resolve));
      // Headers, one chunk, then silence - the shape a stalled proxy actually has.
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/geo+json', 'Content-Length': '999999' });
        res.write('{"type":"FeatureCollection","features":[');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
      process.env.VECTOR_EXPORT_SOURCE_HOSTS = `127.0.0.1:${port}`;

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toBeDefined();
    });

    it('refuses a source that names a gdal command line of its own', async () => {
      // The nested decoy satisfies any text check for a FeatureCollection, so only the skipped driver can stop this.
      body =
        '{"type":"gdal_streamed_alg","command_line":"vector convert /etc/hosts out.geojson","decoy":{"type":"FeatureCollection"}}';

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toMatchObject({
        type: 'OGR2OGR_FAILED',
      });
    });

    it('refuses a source that is not a json document', async () => {
      // A crafted VRT at an allowlisted host would otherwise make GDAL open whatever datasource it names, including a local file.
      body =
        '<OGRVRTDataSource><OGRVRTLayer name="x"><SrcDataSource>/etc/hostname</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>';
      contentType = 'application/xml';

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toMatchObject({
        type: 'SOURCE_NOT_GEOJSON',
      });
    });

    it('refuses a source past the byte cap', async () => {
      process.env.VECTOR_EXPORT_MAX_SOURCE_BYTES = '16';

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toMatchObject({
        type: 'SOURCE_TOO_LARGE',
      });
    });

    it('reports a source the server refuses', async () => {
      server.close();
      server = createServer((_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code></Error>');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
      process.env.VECTOR_EXPORT_SOURCE_HOSTS = `127.0.0.1:${port}`;

      await expect(exportUrlLayer(GPKG_FORMAT)).rejects.toMatchObject({
        type: 'SOURCE_FETCH_FAILED',
      });
    });
  });

  it('keeps a declared field no feature carries, as a null column', async () => {
    // uetk-api declares a fixed field list, and `JSON.stringify` drops an undefined property.
    const layers: VectorExportLayer[] = [
      {
        name: 'Upes',
        geojson: polygonFC,
        fields: [
          { name: 'placeId', type: 'Integer', alias: 'Radavietės ID' },
          { name: 'kadastro_id', type: 'String', alias: 'Identifikavimo kodas' },
        ],
      },
    ];

    const { stream, filename } = await runVectorExport({
      layers,
      name: 'israsas-1',
      srid: 3346,
      format: GPKG_FORMAT,
    });
    const target = join(dir, filename);
    await pipeline(stream, createWriteStream(target));

    expect(fieldNamesOf(target, 'Upes')).toEqual(['placeId', 'kadastro_id']);
    expect(execFileSync('ogrinfo', ['-so', target, 'Upes'], { encoding: 'utf8' })).toMatch(
      /Feature Count: 1/,
    );
  });

  it('keeps the full field names in a geopackage holding every layer', async () => {
    const { target, filename, contentType } = await exportTo(GPKG_FORMAT, dir);

    expect(filename).toBe('israsas-1.gpkg');
    expect(contentType).toBe('application/geopackage+sqlite3');
    expect(fieldNamesOf(target, 'Radavietes')).toEqual(['placeId', 'placeCode', 'placeCreatedAt']);
    expect(fieldNamesOf(target, 'Stebejimai')).toEqual(['formId', 'observedAt']);
  });
});

describe('sweepAbandonedStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('leaves a stream that keeps reading alone', () => {
    const stream = { bytesRead: 0 };
    const onAbandoned = jest.fn();
    sweepAbandonedStream(stream, onAbandoned);

    for (let i = 0; i < 3; i++) {
      stream.bytesRead += 64 * 1024;
      jest.advanceTimersByTime(DOWNLOAD_IDLE_SWEEP_MS);
    }

    expect(onAbandoned).not.toHaveBeenCalled();
  });

  it('sweeps a stream that stopped reading', () => {
    const onAbandoned = jest.fn();
    sweepAbandonedStream({ bytesRead: 0 }, onAbandoned);

    jest.advanceTimersByTime(DOWNLOAD_IDLE_SWEEP_MS);

    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('sweeps a stream that trickles past the absolute deadline', () => {
    const stream = { bytesRead: 0 };
    const onAbandoned = jest.fn();
    sweepAbandonedStream(stream, onAbandoned);

    const start = Date.now();
    while (Date.now() - start <= DOWNLOAD_MAX_MS) {
      stream.bytesRead += 1;
      jest.advanceTimersByTime(DOWNLOAD_IDLE_SWEEP_MS);
    }

    expect(onAbandoned).toHaveBeenCalledTimes(1);
  });
});
