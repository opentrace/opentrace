interface Props {
  onSelect: (prompt: string) => void;
}

const TEMPLATES = [
  {
    label: 'Overview',
    description: 'Architecture overview with node types and connections',
    prompt:
      "Give me an overview of this system's architecture. What node types exist and how are they connected?",
  },
  {
    label: 'List services',
    description: 'Enumerate services and describe their roles',
    prompt:
      'Search the code for services in this system. Look for classes, modules, or files that act as services and briefly describe what each one does based on its connections and source code.',
  },
  {
    label: 'Find dependencies',
    description: 'Identify critical nodes with the most connections',
    prompt:
      'What are the most critical dependencies in this system? Which nodes have the most incoming connections?',
  },
  {
    label: 'Database usage',
    description: 'Which databases exist and what connects to them',
    prompt:
      'Search the code for database usage in this system. Look for database connections, ORMs, query builders, or migration files and describe which components interact with databases.',
  },
  {
    label: 'Code review',
    description: 'Review recent PR changes for bugs and quality issues',
    prompt:
      'Review the most recent pull request for bugs, security issues, and code quality. Focus on substantive issues.',
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
