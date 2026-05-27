import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

// 1. Helper to recursively find all png files in a directory
function findPngFiles(dir, isLocal, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(findPngFiles(fullPath, isLocal, baseDir));
    } else if (file.toLowerCase().endsWith('.png')) {
      const relativePath = path.relative(baseDir, fullPath);
      const components = getNormalizedComponents(relativePath);
      const { scale, priority } = getScaleAndPriority(relativePath);
      results.push({
        fullPath,
        relativePath,
        components,
        scale,
        scalePriority: priority,
        isLocal
      });
    }
  }
  return results;
}

// 2. Helper to get normalized components of a candidate relative path
function getNormalizedComponents(relPath) {
  let base = relPath.replace(/\.png$/i, '');
  base = base.replace(/-4x$/i, '').replace(/-2x$/i, '');
  return base.toLowerCase().split(/[/\-_\\]+/).filter(Boolean);
}

// 3. Helper to get components of XML path
function getXmlComponents(xmlPath) {
  let base = xmlPath.replace(/\.png$/i, '');
  return base.toLowerCase().split(/[/\-_\\]+/).filter(c => c && c !== '..' && c !== '.');
}

// 4. Helper to determine scale and sorting priority from filename scale suffix
function getScaleAndPriority(relPath) {
  const base = relPath.replace(/\.png$/i, '');
  if (base.endsWith('-4x')) {
    return { scale: 0.25, priority: 3 };
  } else if (base.endsWith('-2x')) {
    return { scale: 0.5, priority: 2 };
  } else {
    return { scale: 1.0, priority: 1 };
  }
}

// 5. Helper to check if arrA is a subset of arrB
function isSubset(arrA, arrB) {
  return arrA.every(x => arrB.includes(x));
}

// 6. Simple HTML escaper
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function main() {
  try {
    const facesListPath = path.resolve('faces.txt');
    if (!fs.existsSync(facesListPath)) {
      console.error('ERROR: faces.txt not found at the workspace root.');
      process.exit(1);
    }

    const faces = fs.readFileSync(facesListPath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    console.log(`Loaded ${faces.length} faces from faces.txt`);

    const generatedDir = path.resolve('src/faces/generated');
    if (!fs.existsSync(generatedDir)) {
      fs.mkdirSync(generatedDir, { recursive: true });
    }

    // Scan parts-bin once to optimize performance
    const partsBinFiles = findPngFiles('src/watch/assets/parts-bin', false);

    const metadata = {};
    const facesListConfig = [];
    const faceCardsHtmlLines = [];

    for (const slug of faces) {
      console.log(`Processing face "${slug}"...`);
      const slugDir = path.join('src/watch/assets', slug);
      if (!fs.existsSync(slugDir)) {
        console.error(`ERROR: Directory for face "${slug}" does not exist at "${slugDir}".`);
        process.exit(1);
      }

      const xmlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.xml'));
      if (xmlFiles.length !== 1) {
        console.error(`ERROR: Expected exactly one XML file in "${slugDir}", found ${xmlFiles.length}.`);
        process.exit(1);
      }

      const xmlFile = xmlFiles[0];
      const xmlPath = path.join(slugDir, xmlFile);
      const xmlContent = fs.readFileSync(xmlPath, 'utf8');

      // Parse XML
      const dom = new JSDOM(xmlContent, { contentType: 'text/xml' });
      const doc = dom.window.document;
      const watchNode = doc.querySelector('watch');
      if (!watchNode) {
        console.error(`ERROR: No <watch> node found in "${xmlPath}".`);
        process.exit(1);
      }

      const displayName = watchNode.getAttribute('displayName');
      const description = watchNode.getAttribute('description');
      const urlAbbrev = watchNode.getAttribute('urlAbbrev');
      const worldTimeRing = watchNode.getAttribute('worldTimeRing') || '';
      const worldTimeSubdials = watchNode.getAttribute('worldTimeSubdials') || '';

      const bezelColor = watchNode.getAttribute('bezelColor') || '';

      // Strictly validate displayName and description are present
      if (!displayName) {
        console.error(`ERROR: Missing required attribute 'displayName' on <watch> in "${xmlPath}".`);
        process.exit(1);
      }
      if (!description) {
        console.error(`ERROR: Missing required attribute 'description' on <watch> in "${xmlPath}".`);
        process.exit(1);
      }

      // Populate metadata map
      metadata[slug] = {
        displayName,
        description,
        urlAbbrev,
        worldTimeRing,
        worldTimeSubdials
      };

      // Populate faces list config for picker page
      facesListConfig.push({
        slug,
        name: displayName,
        thumb: `thumb-${slug}.png`,
        abbrev: urlAbbrev || '',
        bezelColor
      });

      // Populate cards HTML fragment
      faceCardsHtmlLines.push(`      <a class="face-card" href="${slug}.html">`);
      faceCardsHtmlLines.push(`        <img class="thumb" src="thumb-${slug}.png" alt="${escapeHtml(displayName)}" />`);
      faceCardsHtmlLines.push(`        <h2>${escapeHtml(displayName)}</h2>`);
      faceCardsHtmlLines.push(`        <p class="desc">${escapeHtml(description)}</p>`);
      faceCardsHtmlLines.push(`      </a>`);

      // Find all referenced png paths in attributes
      const elements = doc.querySelectorAll('*');
      const pngPaths = new Set();
      for (const elem of elements) {
        for (const attr of elem.attributes) {
          if (attr.value.toLowerCase().endsWith('.png')) {
            pngPaths.add(attr.value);
          }
        }
      }

      const sortedPngPaths = Array.from(pngPaths).sort();
      const localFiles = findPngFiles(slugDir, true);

      // Resolve each PNG
      const importStatements = [];
      const imageMappingLines = [];
      let imgIndex = 0;

      for (const pngPath of sortedPngPaths) {
        const xmlComponents = getXmlComponents(pngPath);
        const candidates = [];

        // Check local files first
        for (const file of localFiles) {
          if (isSubset(file.components, xmlComponents)) {
            candidates.push(file);
          }
        }

        // Then check parts-bin files
        for (const file of partsBinFiles) {
          if (isSubset(file.components, xmlComponents)) {
            candidates.push(file);
          }
        }

        // Sort candidates by our heuristic
        candidates.sort((a, b) => {
          if (a.isLocal !== b.isLocal) {
            return a.isLocal ? -1 : 1;
          }
          if (a.components.length !== b.components.length) {
            return b.components.length - a.components.length;
          }
          return b.scalePriority - a.scalePriority;
        });

        if (candidates.length === 0) {
          console.error(`ERROR: Failed to resolve image path "${pngPath}" referenced in "${xmlPath}".`);
          process.exit(1);
        }

        const resolvedFile = candidates[0];
        const importName = `img_${imgIndex++}`;
        let relativeImportPath = path.relative('src/faces/generated', resolvedFile.fullPath).replace(/\\/g, '/');
        if (!relativeImportPath.startsWith('.')) {
          relativeImportPath = './' + relativeImportPath;
        }

        importStatements.push(`import ${importName} from '${relativeImportPath}';`);
        imageMappingLines.push(`        '${pngPath}': { dataUrl: ${importName}, scale: ${resolvedFile.scale} },`);
      }

      // Write face-<slug>.ts
      let xmlImportPath = path.relative('src/faces/generated', xmlPath).replace(/\\/g, '/');
      if (!xmlImportPath.startsWith('.')) {
        xmlImportPath = './' + xmlImportPath;
      }

      const faceTsContent = `/**
 * Auto-generated face data for ${displayName} — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '${xmlImportPath}';
import thumbImg from '../thumb-${slug}.png';
${importStatements.join('\n')}

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: '${displayName.replace(/'/g, "\\'")}',
    urlAbbrev: '${urlAbbrev}',
    xml,
    thumb: thumbImg,
    images: {
${imageMappingLines.join('\n')}
    },
});
`;

      fs.writeFileSync(path.join(generatedDir, `face-${slug}.ts`), faceTsContent, 'utf8');
    }

    // Write metadata.json
    fs.writeFileSync(
      path.join(generatedDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    // Write faces-list.ts
    const facesListImports = [];
    const facesListItems = [];
    for (const item of facesListConfig) {
      const varName = `thumb_${item.slug.replace(/[^a-zA-Z0-9]/g, '_')}`;
      facesListImports.push(`import ${varName} from '../thumb-${item.slug}.png';`);
      facesListItems.push(`    {
        slug: '${item.slug}',
        name: '${item.name.replace(/'/g, "\\'")}',
        thumb: '${item.thumb}',
        thumbDataUrl: ${varName},
        abbrev: '${item.abbrev}',
        bezelColor: '${item.bezelColor}'
    }`);
    }

    const facesListTsContent = `/**
 * Auto-generated faces list configuration.
 */
${facesListImports.join('\n')}

export interface FaceInfo {
    slug: string;
    name: string;
    thumb: string;
    thumbDataUrl: string;
    abbrev: string;
    bezelColor: string;
}

export const FACES: FaceInfo[] = [
${facesListItems.join(',\n')}
];
`;
    fs.writeFileSync(path.join(generatedDir, 'faces-list.ts'), facesListTsContent, 'utf8');

    // Write face-cards.html
    fs.writeFileSync(
      path.join(generatedDir, 'face-cards.html'),
      faceCardsHtmlLines.join('\n'),
      'utf8'
    );

    // Write index-order.json
    fs.writeFileSync(
      path.join(generatedDir, 'index-order.json'),
      JSON.stringify(faces),
      'utf8'
    );

    console.log('Successfully generated all face modules, configs, and fragments.');
  } catch (err) {
    console.error('ERROR in face module generation:', err);
    process.exit(1);
  }
}

main();
