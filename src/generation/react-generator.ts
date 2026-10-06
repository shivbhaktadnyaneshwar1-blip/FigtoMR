import {
  buildScaffoldFiles,
  type ComponentScaffoldInput,
  type GeneratedScaffoldFiles,
} from './scaffold.js';
import type { TargetFrontendProfile } from '../target/frontend-profile.js';

export interface FrontendGenerator {
  readonly framework: TargetFrontendProfile['framework'];
  generate(
    input: ComponentScaffoldInput,
    profile: TargetFrontendProfile,
  ): GeneratedScaffoldFiles;
}

/**
 * The first framework generator. Keeping this behind an interface lets a
 * future Vue/Svelte/Angular generator use the same proposal and MR pipeline.
 */
export const reactTypeScriptGenerator: FrontendGenerator = {
  framework: 'react',
  generate(input, profile) {
    const scaffold = buildScaffoldFiles(input);
    const defaultRoot = 'src/components/';
    const componentRoot = `${profile.componentRoot.replace(/\/$/, '')}/`;
    const files = Object.fromEntries(
      Object.entries(scaffold.files).map(([path, contents]) => [
        path.startsWith(defaultRoot) ? `${componentRoot}${path.slice(defaultRoot.length)}` : path,
        contents,
      ]),
    );
    return { ...scaffold, files };
  },
};
