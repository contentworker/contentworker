import { suggestContentTypeIcon } from '@contentworker/domain';
import {
  BookOpen,
  Box,
  Briefcase,
  Calendar,
  File,
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

/**
 * The icon a name stands for, or undefined. By own key only: the stored name is any kebab-case
 * text, and a plain lookup would find `constructor` or `toString` on the object's prototype.
 */
export function contentTypeIcon(name: string | undefined): LucideIcon | undefined {
  return name !== undefined && Object.hasOwn(CONTENT_TYPE_ICONS, name)
    ? CONTENT_TYPE_ICONS[name]
    : undefined;
}

/**
 * The icon a type's name suggests (`suggestContentTypeIcon`), or undefined: what a type saved
 * without an icon is drawn with, and what a new type is given when nobody picks one.
 */
export function suggestedContentTypeIcon(type: {
  readonly name?: string | undefined;
  readonly apiId?: string | undefined;
}): LucideIcon | undefined {
  return contentTypeIcon(suggestContentTypeIcon(type));
}

/**
 * The icon a type is drawn with where every type has one (the content nav): the one it names,
 * else the one its name suggests, else a blank page. No type can choose the blank page, so it
 * never reads as one that did.
 */
export function ContentTypeIcon(props: {
  type: {
    readonly icon?: string | undefined;
    readonly name?: string | undefined;
    readonly apiId?: string | undefined;
  };
  className?: string;
}) {
  const Icon = contentTypeIcon(props.type.icon) ?? suggestedContentTypeIcon(props.type) ?? File;
  return <Icon aria-hidden="true" className={props.className ?? 'size-4 shrink-0'} />;
}
