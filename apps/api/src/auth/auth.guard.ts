/**
 * Проверка входа и прав.
 *
 * Защита включена по умолчанию для всего: маршрут открыт, только если
 * помечен явно. Обратный порядок - закрывать по списку - рано или поздно
 * оставляет незакрытый маршрут, и узнают об этом не разработчики.
 */
import {
  CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException,
  ForbiddenException, createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { AuthService, type Viewer } from "./auth.service.js";

export const SESSION_COOKIE = "clipforge_session";

/** Маршрут доступен без входа. */
export const Public = () => SetMetadata("public", true);

/** Маршрут доступен только администратору. */
export const AdminOnly = () => SetMetadata("adminOnly", true);

export interface WithViewer extends FastifyRequest {
  viewer?: Viewer;
}

/** Кто пришёл - в аргументе обработчика. */
export const CurrentViewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Viewer | null =>
    context.switchToHttp().getRequest<WithViewer>().viewer ?? null,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WithViewer>();
    const token = request.cookies?.[SESSION_COOKIE];
    const viewer = await this.auth.viewerFor(token);
    request.viewer = viewer ?? undefined;

    const isPublic = this.reflector.getAllAndOverride<boolean>("public", [
      context.getHandler(), context.getClass(),
    ]);
    if (isPublic) return true;

    if (!viewer) throw new UnauthorizedException("нужен вход");

    const adminOnly = this.reflector.getAllAndOverride<boolean>("adminOnly", [
      context.getHandler(), context.getClass(),
    ]);
    if (viewer.role === "moderator" && !["GET", "HEAD"].includes(request.method) &&
        !["/api/auth/logout", "/api/auth/profile", "/api/auth/password"].includes(request.url.split("?")[0]!)) {
      throw new ForbiddenException("Модератор имеет доступ только для поддержки и просмотра");
    }
    if (adminOnly && !viewer.isAdmin) {
      throw new ForbiddenException("только для администратора");
    }
    return true;
  }
}
