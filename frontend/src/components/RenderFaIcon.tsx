import * as Fa6 from 'react-icons/fa6';

export default function RenderFaIcon({ name, className = '' }: { name: string; className?: string }) {
  const IconComponent = (Fa6 as any)[name];
  if (!IconComponent) return <Fa6.FaTag className={className} />;
  return <IconComponent className={className} />;
}
