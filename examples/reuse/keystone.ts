import { config } from '@keystone-6/core' 
import { lists } from './schema'

export default config({
  db: {
    provider: 'sqlite',
    url: process.env.DATABASE_URL || 'file:./keystone-example.db',

    // WARNING: this is only needed for our monorepo examples, don't do this
    prismaClientPath: 'node_modules/.myprisma/client',
  },
  lists,
})
