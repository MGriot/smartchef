import * as Fa6 from 'react-icons/fa6';

export default function RenderFaIcon({ name, className = '', color }: { name: string; className?: string; color?: string | null }) {
  const IconComponent = (Fa6 as any)[name];
  const style = color ? { color } : undefined;
  if (!IconComponent) return <Fa6.FaTag className={className} style={style} />;
  return <IconComponent className={className} style={style} />;
}
