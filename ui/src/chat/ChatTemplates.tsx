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
      'List all the services in this graph and briefly describe what each one does based on its connections.',
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
      'What databases exist in this graph and which services connect to them?',
  },
  {
    label: 'Code review',
    description: 'Review recent PR changes for bugs and quality issues',
    prompt:
      'Review the most recent pull request for bugs, security issues, and code quality. Focus on substantive issues.',
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
