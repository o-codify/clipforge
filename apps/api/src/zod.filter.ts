/**
 * Ошибки разбора тела запроса - это 400, а не 500.
 *
 * Тела разбираются схемами zod прямо в обработчиках. Без этого фильтра
 * ZodError выходит наружу как «Internal server error»: клиент видит
 * «сломался сервер» там, где на самом деле он сам прислал не то, и по
 * ответу невозможно понять, какое поле неверно.
 */
import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(error: ZodError, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.code(400).send({
      statusCode: 400,
      error: "Bad Request",
      message: "неверные данные запроса",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
}
