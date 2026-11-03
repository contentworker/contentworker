import {
  BookOpen,
  Box,
  Briefcase,
  Calendar,
  FileText,
  Folder,
  Image,
  LayoutTemplate,
  type LucideIcon,
  Mail,
  MapPin,
  Megaphone,
  Newspaper,
  ShoppingBag,
  Star,
  Tag,
  User,
  Users,
  Video,
} from 'lucide-react';

/**
 * The icons a content type can name (`ContentType.icon`), by their kebab-case names. The model
 * stores any kebab-case name; the admin draws the ones it knows and nothing for the rest, so a
 * name set through the API never breaks a screen.
 */
export const CONTENT_TYPE_ICONS: Readonly<Record<string, LucideIcon>> = {
  'book-open': BookOpen,
  box: Box,
  briefcase: Briefcase,
  calendar: Calendar,
  'file-text': FileText,
  folder: Folder,
  image: Image,
  'layout-template': LayoutTemplate,
  mail: Mail,
  'map-pin': MapPin,
  megaphone: Megaphone,
  newspaper: Newspaper,
  'shopping-bag': ShoppingBag,
  star: Star,
  tag: Tag,
  user: User,
  users: Users,
  video: Video,
};

/** A content type's icon, decorative beside its name; nothing when it names none the admin knows. */
export function ContentTypeIcon(props: { name: string | undefined; className?: string }) {
  const Icon = props.name ? CONTENT_TYPE_ICONS[props.name] : undefined;
  return Icon ? <Icon aria-hidden="true" className={props.className ?? 'size-4 shrink-0'} /> : null;
}
