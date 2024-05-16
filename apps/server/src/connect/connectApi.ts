import type { Member, MemberResponse } from 'interfaces/contract'
import {
  ChallengeType,
  type Connection,
  ConnectionStatus,
  type Institution,
  type LocalInstitution,
  type InstitutionResponse,
  type Challenge
} from '../shared/contract'
import * as logger from '../infra/logger'

import { ProviderApiBase } from '../providers'
import { Client } from '@elastic/elasticsearch'

function mapInstitution (ins: Institution) {
  return ({
    guid: ins.id,
    code: ins.id,
    name: ins.name,
    url: ins.url,
    logo_url: ins.logo_url,
    instructional_data: {},
    credentials: [] as any[],
    supports_oauth: ins.oauth ?? ins.name?.includes('Oauth'),
    providers: ins.providers,
    provider: ins.provider
    // credentials: credentials?.map((c: any) => ({
    //   guid: c.id,
    //   ...c
    // }))
  })
}

function mapInstitutionLocal (ins: LocalInstitution): InstitutionResponse {
  const supportsOauth = ins.mx.supports_oauth || ins.sophtron.supports_oauth
  // || ins.finicity.supports_oauth || ins.akoya.supports_oauth
  return ({
    id: ins.ucp_id,
    guid: ins.ucp_id,
    code: null,
    name: ins.name,
    url: ins.url,
    logo_url: ins.logo,
    instructional_data: null,
    credentials: [] as any[],
    supports_oauth: supportsOauth,
    providers: null,
    provider: null
  })
}

function mapConnection (connection: Connection): Member {
  return {
    // ...connection,
    institution_guid: connection.institution_code,
    guid: connection.id,
    connection_status: connection.status ?? ConnectionStatus.CREATED, // ?
    most_recent_job_guid: connection.status === ConnectionStatus.CONNECTED ? null : connection.cur_job_id,
    is_oauth: connection.is_oauth,
    oauth_window_uri: connection.oauth_window_uri,
    provider: connection.provider,
    is_being_aggregated: connection.is_being_aggregated,
    user_guid: connection.user_id,
    mfa: {
      credentials: connection.challenges?.map(c => {
        const ret = {
          guid: c.id,
          credential_guid: c.id,
          label: c.question,
          type: c.type,
          options: [] as any[]
        } as any
        switch (c.type) {
          case ChallengeType.QUESTION:
            ret.type = 0
            ret.label = (c.data as any[])?.[0].value || c.question
            break
          case ChallengeType.TOKEN:
            ret.type = 2 // ?
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            ret.label = `${c.question}: ${c.data}`
            break
          case ChallengeType.IMAGE:
            ret.type = 13
            // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
            ret.meta_data = (c.data as string).startsWith('data:image') ? c.data : ('data:image/png;base64, ' + c.data)
            break
          case ChallengeType.OPTIONS:
            ret.type = 2
            ret.options = (c.data as any[]).map(d => ({
              guid: d.key,
              label: d.key,
              value: d.value,
              credential_guid: c.id
            }))
            break
          case ChallengeType.IMAGE_OPTIONS:
            ret.type = 14
            ret.options = (c.data as any[]).map(d => ({
              guid: d.key,
              label: d.key,
              data_uri: d.value,
              credential_guid: c.id
            }))
            break
        }
        return ret
      }
      )
    }
  } as any
}

export class ConnectApi extends ProviderApiBase {
  client: any
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor (req: any) {
    super(req)
    this.client = new Client({ node: 'http://localhost:9200' });
  }

  async addMember (memberData: Member): Promise<MemberResponse> {
    const connection = await this.createConnection({
      institution_id: memberData.institution_guid,
      is_oauth: (memberData.is_oauth ?? false),
      skip_aggregation: (memberData.skip_aggregation ?? false) && (memberData.is_oauth ?? false),
      initial_job_type: this.context.job_type ?? 'agg',
      credentials: memberData.credentials?.map(c => ({
        id: c.guid,
        value: c.value
      })) ?? []
    })
    return { member: mapConnection(connection) }
  }

  async updateMember (member: Member): Promise<MemberResponse> {
    if (this.context.current_job_id && member.credentials !== undefined) {
      await this.answerChallenge(
        member.guid,
        member.credentials.map(c => {
          const ret: Challenge = {
            id: c.guid,
            type: c.field_type,
            response: c.value
          }
          const challenge = member.mfa?.credentials.find(m => m.guid === c.guid) // widget posts everything back
          switch (challenge?.type) {
            case 0:
              ret.type = ChallengeType.QUESTION
              break
            case 13:
              ret.type = ChallengeType.IMAGE
              break
            case 2:
              ret.type = c.value ? ChallengeType.OPTIONS : ChallengeType.TOKEN
              if (c.value) {
                ret.response = challenge?.options.find((o: any) => o.guid === c.value)?.value
                if (!ret.response) {
                  logger.error(`Unexpected challege option: ${c.value}: `, challenge)
                }
              }
              break
          }
          return ret
        })
      )
      return { member }
    } else {
      const connection = await this.updateConnection({
        job_type: this.context.job_type,
        id: member.guid,
        credentials: member.credentials?.map(c => ({
          id: c.guid,
          value: c.value
        }))
      })
      return { member: mapConnection(connection) }
    }
  }

  async loadMembers (): Promise<Member[]> {
    if (this.context.connection_id != null && this.context.connection_id !== '') {
      const focusedMember = await this.getConnection(this.context.connection_id)
      return [mapConnection(focusedMember)]
    }
    return []
  }

  async loadMemberByGuid (memberGuid: string): Promise<MemberResponse> {
    const mfa = await this.getConnectionStatus(memberGuid)
    if (mfa?.institution_code == null) {
      const connection = await this.getConnection(memberGuid)
      return { member: mapConnection({ ...mfa, ...connection }) }
    }
    return { member: mapConnection({ ...mfa }) }
  }

  async getOauthWindowUri (memberGuid: string) {
    const ret = await this.loadMemberByGuid(memberGuid)
    return ret?.member?.oauth_window_uri
  }

  async deleteMember (member: Member): Promise<void> {
    await this.deleteConnection(member.guid)
  }

  async getMemberCredentials (memberGuid: string): Promise<any> {
    const crs = await this.getConnectionCredentials(memberGuid)
    return {
      credentials: crs.map(c => ({
        ...c,
        guid: c.id,
        field_type: c.field_type === 'PASSWORD' ? 1 : 3
      }))
    }
  }

  async getInstitutionCredentials (guid: string): Promise<any> {
    const crs = await super.getInstitutionCredentials(guid)
    return {
      credentials: crs.map(c => ({
        ...c,
        guid: c.id,
        field_type: c.field_type === 'PASSWORD' ? 1 : 3
      }))
    }
  }

  async loadInstitutions (query: string): Promise<any> {
    // const ret = await this.search(query)
    const stuff = await this.client.search({
      index: 'institutions',
      body: {
        query: {
          multi_match: {
            query: query,
            fields: ['name', 'keywords']
          }
        }
      }
    })
    const institutionHits = stuff.hits.hits.map((esObject: { _source: any }) => esObject._source)
    // return ret.map(mapInstitution)
    return institutionHits.map(mapInstitutionLocal)
  }

  async loadInstitutionByGuid (guid: string): Promise<any> {
    const inst = await this.getInstitution(guid)
    return { institution: mapInstitution(inst) }
  }

  // loadInstitutionByCode(code: string): Promise<Institution> {
  //   let client = getApiClient({provider: config.DefaultProvider});
  //   throw new Error('Method not implemented.');
  // }

  async loadPopularInstitutions (query: string) {
    this.context.updated = true
    this.context.provider = null
    const ret = await this.institutions()
    return ret.institutions.map(mapInstitution)
  }

  async loadDiscoveredInstitutions (): Promise<Institution[]> {
    return []
  }
}
