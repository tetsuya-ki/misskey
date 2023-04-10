import { Inject, Injectable } from '@nestjs/common';
import type { NotesRepository, UsersRepository, FollowingsRepository } from '@/models/index.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueryService } from '@/core/QueryService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../error.js';
import { Brackets } from 'typeorm';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		unavailable: {
			message: 'Search of notes unavailable.',
			code: 'UNAVAILABLE',
			id: '0b44998d-77aa-4427-80d0-d2c9b8523011',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		query: { type: 'string' },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		offset: { type: 'integer', default: 0 },
		host: {
			type: 'string',
			nullable: true,
			description: 'The local host is represented with `null`.',
		},
		userId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
		channelId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
	},
	required: ['query'],
} as const;

// TODO: ロジックをサービスに切り出す

// eslint-disable-next-line import/no-default-export
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> {
	constructor(
		@Inject(DI.config)
		private config: Config,
	
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private noteEntityService: NoteEntityService,
		private queryService: QueryService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me ? me.id : null);
			if (!policies.canSearchNotes) {
				throw new ApiError(meta.errors.unavailable);
			}
	
			const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'), ps.sinceId, ps.untilId);

			// add from,start,end,reactions query
			let username: String = '';
			let start: Date | null = null;
			let end: Date | null = null;
			let reactions: Number | null = null;
			let home: String = '';

			// 半角スペースで分割し、該当のクエリの場合抽出する
			const startQuery = 'start:';
			const endQuery = 'end:';
			const fromQuery = 'from:';
			const reactionsQuery = 'reactions:';
			const homeQuery = 'home:';
			let queryStr = '';
			ps.query.split(' ').forEach(str => {
				if (str.startsWith(startQuery)) {
					const startStr = str.slice(startQuery.length);
					start = new Date(startStr);
				} else if (str.startsWith(endQuery)) {
					const endStr = str.slice(endQuery.length);
					end = new Date(endStr);
				} else if (str.startsWith(fromQuery)) {
					username = str.slice(fromQuery.length);
				} else if (str.startsWith(reactionsQuery)) {
					reactions = Number(str.slice(reactionsQuery.length));
				} else if (str.startsWith(homeQuery)) {
					home = str.slice(homeQuery.length);
				} else {// 意味あるものじゃない場合、検索文字列
					queryStr = queryStr + str + ' ';
				}
			});
			ps.query = queryStr.trim();

			// from句の処理(存在するユーザー名の場合、Noteをそのユーザーのみとする)
			if (username) {
				const user = await this.usersRepository.findOneBy({ usernameLower: username.toLowerCase() });
				if (user) {
					query.andWhere('note.userId = :userId', { userId: user.id });
				}
			}
			// 日付の範囲条件を生成して、queryに追加
			if (start) {
				(start as Date).setHours(0, 0, 0, 0); // 開始日の範囲を調整
				query.andWhere("note.createdAt >= :start", { start: start });
			}
			if (end) {
				(end as Date).setHours(23, 59, 59, 999); // 終了日の範囲を調整
				query.andWhere("note.createdAt <= :end", { end: end });
			}
			// scoreがreactionsに指定された数字以上
			if (reactions) {
				query.andWhere("note.score >= :reactions", { reactions: reactions });
			}

			// home句の処理(存在するユーザー名の場合、Noteをそのユーザーとフォロワーのみ(ホームタイムライン風)とする)
			if (home) {
				const tagetUser = await this.usersRepository.findOneBy({ usernameLower: home.toLowerCase() });
				if (tagetUser) {
					const followingQuery = this.followingsRepository.createQueryBuilder('following')
					.select('following.followeeId')
					.where('following.followerId = :targetId');
					query.andWhere(new Brackets(qb => { qb
						// または 対象自身
						.where('note.userId = :targetId')
						.orWhere(':targetId = ANY(note.mentions)')
						.orWhere(new Brackets(qb => { qb
							// または publicかhome宛ての投稿であり、
							.where('note.visibility IN (\'home\', \'public\')')
							.andWhere(new Brackets(qb => { qb
								// 対象がフォロワーである
								.where(`note.userId IN (${ followingQuery.getQuery() })`)
								// または 対象の投稿へのリプライ
								.orWhere('note.replyUserId = :targetId');
							}));
						}));
					}));
					query.setParameters({ targetId: tagetUser.id });
				}
			}

			if (ps.userId) {
				query.andWhere('note.userId = :userId', { userId: ps.userId });
			} else if (ps.channelId) {
				query.andWhere('note.channelId = :channelId', { channelId: ps.channelId });
			}

			query
				.andWhere('note.text ILIKE :q', { q: `%${ sqlLikeEscape(ps.query) }%` })
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser');

			this.queryService.generateVisibilityQuery(query, me);
			if (me) this.queryService.generateMutedUserQuery(query, me);
			if (me) this.queryService.generateBlockedUserQuery(query, me);

			const notes = await query.take(ps.limit).getMany();

			return await this.noteEntityService.packMany(notes, me);
		});
	}
}
