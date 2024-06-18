describe('unsupported provider', () => {
  it('filters out institutions which are not supported by a provider in your list of supported providers.', async () => {
    cy.visitAgg()
    cy.findByPlaceholderText('Search').type('MX Bank')

    cy.findByText('BBVA MX').should('exist')
    cy.findByText('https://www.anbbank.com/').should('exist')
    cy.findByText('MX Bank (Oauth)').should('not.exist')
  })
})
