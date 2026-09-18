import { Controller, Post, Body } from '@nestjs/common';
import { SendDailyDevotionalUseCase } from '../../../application/devotional/usecases/send-daily-devotional.usecase';
import { GetGroupIdByNameUseCase } from '../../../application/devotional/usecases/get-group-id-by-name.usecase';
import { TargetSendDailyDevotionalUseCase } from '../../../application/devotional/usecases/target-send-daily-devotional.usecase';

export class SearchQuery {
  readonly value: string;
}

@Controller('cron')
export class CronController {
  constructor(
    private readonly sendDailyDevotional: SendDailyDevotionalUseCase,
    private readonly groupIdByNameUseCase: GetGroupIdByNameUseCase,
    private readonly targetSendDailyDevotionalUseCase: TargetSendDailyDevotionalUseCase,
  ) {}

  /* hit this endpoint if you are using http cronjob */
  @Post('devotional')
  async handleDailyDevotional() {
    await this.sendDailyDevotional.execute();
    return { status: 'ok' };
  }

  @Post('devotional/find-group')
  async getGroupIdByName(@Body() query: SearchQuery) {
    await this.groupIdByNameUseCase.execute(query.value);
  }

  @Post('devotional/single-group')
  async handleSingleTargetDailyDevotional() {
    await this.targetSendDailyDevotionalUseCase.execute();
    return { status: 'ok' };
  }
}
