/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

interface Props {
  onSelect: (prompt: string) => void;
}

const TEMPLATES = [
  {
    label: 'Explore architecture',
    description: 'Deep dive into how the system is structured',
    prompt:
      'Explore the overall architecture of this system. What are the main components, how are they structured, and how do they connect to each other?',
  },
  {
    label: 'Find usages',
    description: 'Discover what calls or depends on a key component',
    prompt:
      'What are the most connected components in this system? Pick the one with the most consumers and show me everything that uses it.',
  },
  {
    label: 'Map dependencies',
    description: 'Trace what a component depends on',
    prompt:
      'Pick a central service or class in this system and map out all of its dependencies. What does it call, import, or rely on?',
  },
  {
    label: 'Blast radius',
    description: 'Assess the impact of changing a critical component',
    prompt:
      'What would be the blast radius of changing the most-connected component in this system? Show me both what depends on it and what it depends on.',
  },
  {
    label: 'Code review',
    description: 'Review recent PR changes for bugs and quality issues',
    prompt:
      'Review the most recent pull request for bugs, security issues, and code quality. Focus on substantive issues.',
  },
  {
    label: 'Database usage',
    description: 'Which databases exist and what connects to them',
    prompt:
      'Search the code for database usage in this system. Look for database connections, ORMs, query builders, or migration files and describe which components interact with databases.',
  },
  {
    label: 'Documentation gaps',
    description: 'Find missing or outdated documentation across the system',
    prompt:
      'Are there any gaps in documentation? Identify services, APIs, or components that are missing or have outdated docs.',
  },
  {
    label: 'Run locally',
    description: 'Steps to set up and run the system on your machine',
    prompt:
      'How can I run this system locally? Walk me through the setup steps, prerequisites, and configuration needed.',
  },
  {
    label: 'Production setup',
    description: 'How the system is deployed and runs in production',
    prompt:
      'How does this system run in production? Describe the deployment architecture, infrastructure, and key operational details.',
  },
  {
    label: 'Testing gaps',
    description: 'Identify areas with missing or insufficient test coverage',
    prompt:
      'Are there any gaps in testing? Identify components or services that lack adequate test coverage or have weak spots.',
  },
  {
    label: 'Performance issues',
    description: 'Spot potential bottlenecks and performance concerns',
    prompt:
      'Are there any performance issues in this system? Look for bottlenecks, slow queries, N+1 problems, or resource-heavy components.',
  },
];

export default function ChatTemplates({ onSelect }: Props) {
  return (
    <div className="chat-templates" data-testid="chat-examples">
      <div className="templates-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.label}
            className="template-card"
            onClick={() => onSelect(t.prompt)}
            data-testid={`chat-example-${t.label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <span className="template-card-label">{t.label}</span>
            <span className="template-card-desc">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
