#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadEnv, resolveTargetRepoPath } from '../src/config/env.js';
import { runFigtoMRAgent } from '../src/agent/runner.js';
import { parseFigmaUrl } from '../src/utils/figma-url.js';
import { setLogLevel, type LogLevel } from '../src/utils/logger.js';
import { toPascalCase } from '../src/utils/names.js';

const program = new Command();

program
  .name('figto-mr')
  .description(
    'Figma MCP → repository-aware frontend component generator.',
  )
  .argument('<url>', 'Figma design URL, including node-id')
  .option('-n, --name <PascalName>', 'Target component name (PascalCase)')
  .option('--target-repo <path>', 'Path to the local target frontend checkout')
  .option('--write', 'Write generated files into the target repository (disables dry-run)', false)
  .option('--dry-run', 'Preview files without writing (default)', false)
  .option('--message <text>', 'Extra instruction for the agent')
  .option('--log-level <level>', 'debug | info | warn | error | silent', 'info')
  .action(
    async (
      url: string,
      options: {
        name?: string;
        targetRepo?: string;
        write?: boolean;
        dryRun?: boolean;
        message?: string;
        logLevel?: string;
      },
    ) => {
      const env = loadEnv();
      setLogLevel((options.logLevel as LogLevel) ?? env.STUDIO_LOG_LEVEL);

      const parsed = parseFigmaUrl(url);
      const componentName = options.name
        ? toPascalCase(options.name)
        : parsed.title
          ? toPascalCase(parsed.title)
          : undefined;
      const repoPath = options.targetRepo ?? env.TARGET_REPO_PATH;
      try {
        resolveTargetRepoPath({ ...env, TARGET_REPO_PATH: repoPath });
      } catch (error) {
        console.warn(chalk.yellow(String(error)));
      }

      const dryRun = options.write
        ? false
        : options.dryRun
          ? true
          : (env.STUDIO_DRY_RUN ?? true);
      const spinner = ora('Running FigtoMR agent...').start();

      try {
        const result = await runFigtoMRAgent({
          figmaUrl: url,
          componentName,
          targetRepoPath: repoPath,
          dryRun,
          message:
            options.message ??
            `Generate a production-ready frontend component for this Figma node. Detect the target repo conventions and produce semantic React and CSS that match the frame.`,
        });
        spinner.succeed('Agent finished.');
        console.log('\n' + chalk.bold('Agent response'));
        console.log(result.text);
        console.log('\n' + chalk.bold('Execution state'));
        console.log(result.stateSummary);
      } catch (error) {
        spinner.fail('Agent failed.');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    },
  );

program
  .command('parse')
  .description('Parse a Figma URL without invoking the LLM')
  .argument('<url>')
  .action((url: string) => {
    console.log(JSON.stringify(parseFigmaUrl(url), null, 2));
  });

await program.parseAsync(process.argv);
