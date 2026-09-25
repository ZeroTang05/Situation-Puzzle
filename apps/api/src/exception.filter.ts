/** 全局异常过滤器：DomainError / HttpException / 未知错误 → 统一错误体。 */
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '@jev/domain';
import { JevError } from '@jev/jev';
import { domainErrorStatus, errorBody } from './common/http.js';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      res.status(domainErrorStatus(exception.code)).json(errorBody(exception.code, exception.message, exception.params));
      return;
    }

    if (exception instanceof JevError) {
      // Jev 故障以明确的业务状态返回，不伪装成判定结果
      this.logger.error(`Jev 调用失败 [${exception.errorClass}]：${exception.message}`);
      const code = exception.errorClass === 'rate_limited' ? 'JEV_BUSY' : 'JEV_UNAVAILABLE';
      res.status(domainErrorStatus(code)).json(errorBody(code, exception.message));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message = typeof payload === 'string' ? payload : ((payload as { message?: string }).message ?? exception.message);
      const code = status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : status === HttpStatus.UNAUTHORIZED ? 'UNAUTHORIZED' : status === HttpStatus.FORBIDDEN ? 'FORBIDDEN' : 'VALIDATION_FAILED';
      res.status(status).json(errorBody(code, Array.isArray(message) ? message[0]! : message));
      return;
    }

    this.logger.error('未处理异常', exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(errorBody('INTERNAL', '服务器出了点问题，请稍后再试。'));
  }
}
