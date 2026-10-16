import { Badge, BadgeDot } from './Badge';

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'running' ? 'accent' : status === 'success' || status === 'passed' ? 'green' : status === 'failed' ? 'red' : 'neutral';
  return (
    <Badge tone={tone}>
      <BadgeDot spinning={status === 'running'} />
      {status.replace(/[_-]+/g, ' ')}
    </Badge>
  );
}
