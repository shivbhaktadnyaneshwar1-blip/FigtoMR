import { describe, expect, it } from 'vitest';
import { filterToProposalScope, isAllowedStudioMrPath, isProposalScopedPath } from '../src/utils/file-writer.js';

describe('isAllowedStudioMrPath', () => {
  it('allows only generated component folders', () => {
    expect(isAllowedStudioMrPath('src/components/pricing-card/PricingCard.tsx')).toBe(true);
    expect(isAllowedStudioMrPath('src/components/pricing-card/pricing-card.css')).toBe(true);
    expect(isAllowedStudioMrPath('src/routes.ts')).toBe(false);
    expect(isAllowedStudioMrPath('tsup.config.ts')).toBe(false);
    expect(isAllowedStudioMrPath('src/custom-components/widget/render.tsx')).toBe(false);
  });
});

describe('isProposalScopedPath', () => {
  it('keeps the current component and drops leftovers', () => {
    expect(
      isProposalScopedPath('src/components/agent-hub-content/AgentHubContent.tsx', 'AgentHubContent'),
    ).toBe(true);
    expect(
      isProposalScopedPath('src/components/agent-dashboard/AgentDashboard.tsx', 'AgentHubContent'),
    ).toBe(false);
    expect(isProposalScopedPath('src/routes.ts', 'AgentHubContent')).toBe(false);
    expect(
      filterToProposalScope(
        [
          'src/components/agent-hub-content/AgentHubContent.tsx',
          'src/components/agent-dashboard/AgentDashboard.tsx',
          'src/routes.ts',
        ],
        'AgentHubContent',
      ),
    ).toEqual(['src/components/agent-hub-content/AgentHubContent.tsx']);
  });

  it('uses a detected component root instead of assuming src/components', () => {
    const profile = { componentRoot: 'ui/components' };
    expect(
      isProposalScopedPath('ui/components/agent-hub-content/AgentHubContent.tsx', 'AgentHubContent', profile),
    ).toBe(true);
    expect(isAllowedStudioMrPath('src/components/agent-hub-content/AgentHubContent.tsx', profile)).toBe(
      false,
    );
  });
});
