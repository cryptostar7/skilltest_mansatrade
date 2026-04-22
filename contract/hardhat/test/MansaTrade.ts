import { expect } from "chai";
import { ethers } from "hardhat";

describe("MansaTrade", function () {
  const ADMIN = "0x95E7D2F2C071E1Cd8c10B8c9c579B007c67A37e1";

  async function deployFixture() {
    const [deployer, offerOwner, seller, firDiv, secDiv, randomUser] =
      await ethers.getSigners();

    const tradeFactory = await ethers.getContractFactory("MansaTrade");
    const trade = (await tradeFactory.deploy(
      await firDiv.getAddress(),
      await secDiv.getAddress()
    )) as any;
    await trade.waitForDeployment();

    const tokenFactory = await ethers.getContractFactory("TestToken");
    const token = (await tokenFactory.deploy(ethers.parseEther("1000000"))) as any;
    await token.waitForDeployment();

    return { trade, token, deployer, offerOwner, seller, firDiv, secDiv, randomUser };
  }

  async function getAdminSigner() {
    await ethers.provider.send("hardhat_setBalance", [ADMIN, "0x3635C9ADC5DEA00000"]);
    await ethers.provider.send("hardhat_impersonateAccount", [ADMIN]);
    return await ethers.getSigner(ADMIN);
  }

  async function createEthOffer(trade: any, offerOwner: any, amount: bigint, tokenAmount?: bigint) {
    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank Transfer",
      "pub-key",
      "terms",
      30,
      true,
      tokenAmount ?? amount * 2n,
      amount,
      amount * 2n
    );
  }

  it("covers ownership transfer and related reverts", async function () {
    const { trade, deployer, offerOwner } = await deployFixture();

    await expect(trade.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
      "Ownable: new owner is the zero address"
    );
    await expect(trade.transferOwnership(await offerOwner.getAddress()))
      .to.emit(trade, "OwnershipTransferred")
      .withArgs(await deployer.getAddress(), await offerOwner.getAddress());
    expect(await trade.owner()).to.equal(await offerOwner.getAddress());

    await expect(
      trade.connect(deployer).transferOwnership(await deployer.getAddress())
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("covers admin-only functions with revert and success", async function () {
    const { trade, deployer, offerOwner, firDiv, secDiv } = await deployFixture();
    const adminSigner = await getAdminSigner();

    await expect(trade.updateFee(50, 70, 30)).to.be.revertedWith("You are not admin!");
    await expect(trade.updateFeeDivider(await deployer.getAddress(), await offerOwner.getAddress()))
      .to.be.revertedWith("You are not admin!");
    await expect(trade.verifyUser(await offerOwner.getAddress())).to.be.revertedWith(
      "You are not admin!"
    );

    await trade.connect(adminSigner).updateFee(100, 60, 40);
    expect(await trade.fee()).to.equal(100n);
    expect(await trade.fir_fee()).to.equal(60n);
    expect(await trade.sec_fee()).to.equal(40n);

    await trade
      .connect(adminSigner)
      .updateFeeDivider(await firDiv.getAddress(), await secDiv.getAddress());
    expect(await trade.fir_div()).to.equal(await firDiv.getAddress());
    expect(await trade.sec_div()).to.equal(await secDiv.getAddress());

    await trade.connect(offerOwner).createUser();
    await trade.connect(adminSigner).verifyUser(await offerOwner.getAddress());
    const verified = await trade.getUser(await offerOwner.getAddress());
    expect(verified.verified).to.equal(true);
  });

  it("covers createUser, updateUser and getUser", async function () {
    const { trade, offerOwner } = await deployFixture();

    await trade.connect(offerOwner).createUser();
    await trade.connect(offerOwner).updateUser(9);

    const user = await trade.getUser(await offerOwner.getAddress());
    expect(user.user_address).to.equal(await offerOwner.getAddress());
    expect(user.verified).to.equal(false);
    expect(user.region).to.equal(9);
    expect(user.thumbs_up).to.equal(0n);
    expect(user.thumbs_down).to.equal(0n);
  });

  it("covers createOffer, updateOffer, cancelOffer and getters", async function () {
    const { trade, offerOwner, randomUser } = await deployFixture();
    const initialAmount = ethers.parseEther("2");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank",
      "pub-key",
      "original terms",
      30,
      true,
      initialAmount,
      ethers.parseEther("0.5"),
      initialAmount
    );

    const offers = await trade.getOffers();
    expect(offers.length).to.equal(1);
    expect(offers[0].owner).to.equal(await offerOwner.getAddress());

    const byIndex = await trade.getOfferByIndex(0);
    expect(byIndex.offer_index).to.equal(0n);
    expect(byIndex.status).to.equal(true);

    const ownerIndexes = await trade.getOfferIndexesOfUser(await offerOwner.getAddress());
    expect(ownerIndexes.length).to.equal(1);
    expect(ownerIndexes[0]).to.equal(0n);

    await expect(
      trade
        .connect(randomUser)
        .updateOffer("EUR", "SEPA", "updated terms", 20, 0, initialAmount, 1, initialAmount)
    ).to.be.revertedWith("You are not owner of offer.");

    await trade
      .connect(offerOwner)
      .updateOffer("EUR", "SEPA", "updated terms", 20, 0, initialAmount, 1, initialAmount);
    const updated = await trade.getOfferByIndex(0);
    expect(updated.fiat).to.equal("EUR");
    expect(updated.payment_options).to.equal("SEPA");
    expect(updated.offer_terms).to.equal("updated terms");
    expect(updated.time_limit).to.equal(20);

    await expect(trade.connect(randomUser).cancelOffer(0)).to.be.revertedWith(
      "You are not owner of offer."
    );

    await trade.connect(offerOwner).cancelOffer(0);
    const cancelled = await trade.getOfferByIndex(0);
    expect(cancelled.status).to.equal(false);
  });

  it("covers ETH order create, buyerConfirm, confirmOrder, and order getters", async function () {
    const { trade, offerOwner, seller, firDiv, secDiv } = await deployFixture();
    const sellAmount = ethers.parseEther("1");

    await createEthOffer(trade, offerOwner, sellAmount);

    await expect(
      trade.connect(seller).createOrder(
        "Bank Transfer",
        "Seller Name",
        "seller@example.com",
        "1000 USD",
        0,
        sellAmount,
        { value: sellAmount }
      )
    ).to.emit(trade, "CreateOrder").withArgs(0);

    const orders = await trade.getOrders();
    expect(orders.length).to.equal(1);
    expect(orders[0].order_index).to.equal(0n);

    const sellerOrderIdx = await trade.getOrderIndexesOfUser(await seller.getAddress());
    const buyerOrderIdx = await trade.getOrderIndexesOfUser(await offerOwner.getAddress());
    expect(sellerOrderIdx[0]).to.equal(0n);
    expect(buyerOrderIdx[0]).to.equal(0n);

    const firBefore = await ethers.provider.getBalance(await firDiv.getAddress());
    const secBefore = await ethers.provider.getBalance(await secDiv.getAddress());

    await expect(trade.connect(seller).buyerConfirm(0)).to.be.revertedWith(
      "You are not buyer of order."
    );
    await trade.connect(offerOwner).buyerConfirm(0);

    await expect(trade.connect(offerOwner).confirmOrder(0)).to.be.revertedWith(
      "You are not seller of order or not admin."
    );
    await trade.connect(seller).confirmOrder(0);

    const order = await trade.getOrderByIndex(0);
    expect(order.status).to.equal(1);
    expect(order.buyer_confirm).to.equal(true);
    expect(order.seller_confirm).to.equal(true);

    const offer = await trade.getOfferByIndex(0);
    expect(offer.bought).to.equal(sellAmount);
    expect(offer.token_amount).to.equal(sellAmount);

    const firAfter = await ethers.provider.getBalance(await firDiv.getAddress());
    const secAfter = await ethers.provider.getBalance(await secDiv.getAddress());
    const expectedFirFee = (sellAmount * 45n * 2n * 80n) / 1_000_000n;
    const expectedSecFee = (sellAmount * 45n * 2n * 20n) / 1_000_000n;
    expect(firAfter - firBefore).to.equal(expectedFirFee);
    expect(secAfter - secBefore).to.equal(expectedSecFee);

    expect(await ethers.provider.getBalance(await trade.getAddress())).to.equal(0n);
  });

  it("covers confirmOrder and cancelOrder revert branches", async function () {
    const { trade, offerOwner, seller, randomUser } = await deployFixture();
    const sellAmount = ethers.parseEther("0.3");

    await createEthOffer(trade, offerOwner, sellAmount, sellAmount);

    await expect(
      trade
        .connect(seller)
        .createOrder("Wire", "Seller Name", "seller@example.com", "300 USD", 0, sellAmount, {
          value: sellAmount - 1n,
        })
    ).to.be.revertedWith("Please send as sell amount");

    await trade
      .connect(seller)
      .createOrder("Wire", "Seller Name", "seller@example.com", "300 USD", 0, sellAmount, {
        value: sellAmount,
      });

    await expect(trade.connect(seller).confirmOrder(0)).to.be.revertedWith(
      "Buyer is not confirm order yet."
    );

    await expect(trade.connect(randomUser).cancelOrder(0)).to.be.revertedWith(
      "You are not buyer or seller or admin."
    );

    await trade.connect(offerOwner).buyerConfirm(0);
    await trade.connect(seller).confirmOrder(0);

    await expect(trade.connect(seller).cancelOrder(0)).to.be.revertedWith("Order is completed.");
  });

  it("allows cancelling pending ETH order and refunding escrow", async function () {
    const { trade, offerOwner, seller } = await deployFixture();
    const sellAmount = ethers.parseEther("0.25");

    await createEthOffer(trade, offerOwner, sellAmount, sellAmount);
    await trade
      .connect(seller)
      .createOrder("Wire", "Seller Name", "seller@example.com", "250 USD", 0, sellAmount, {
        value: sellAmount,
      });

    expect(await ethers.provider.getBalance(await trade.getAddress())).to.equal(sellAmount);
    await trade.connect(offerOwner).cancelOrder(0);
    const order = await trade.getOrderByIndex(0);
    expect(order.status).to.equal(2);
    expect(await ethers.provider.getBalance(await trade.getAddress())).to.equal(0n);
  });

  it("covers thumbUser feedback and self-feedback revert", async function () {
    const { trade, offerOwner, seller } = await deployFixture();
    const sellAmount = ethers.parseEther("0.4");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "PayPal",
      "pub-key",
      "original terms",
      45,
      true,
      sellAmount,
      ethers.parseEther("0.1"),
      sellAmount
    );

    await trade
      .connect(offerOwner)
      .updateOffer("EUR", "SEPA", "updated terms", 25, 0, sellAmount, ethers.parseEther("0.05"), sellAmount);

    const updatedOffer = await trade.getOfferByIndex(0);
    expect(updatedOffer.fiat).to.equal("EUR");
    expect(updatedOffer.payment_options).to.equal("SEPA");
    expect(updatedOffer.offer_terms).to.equal("updated terms");
    expect(updatedOffer.time_limit).to.equal(25);

    await trade.connect(seller).createOrder(
      "SEPA",
      "Seller Name",
      "seller@example.com",
      "400 EUR",
      0,
      sellAmount,
      { value: sellAmount }
    );

    await trade.connect(offerOwner).thumbUser(true, await seller.getAddress(), 0);
    await trade.connect(seller).thumbUser(false, await offerOwner.getAddress(), 0);

    const sellerUser = await trade.getUser(await seller.getAddress());
    const ownerUser = await trade.getUser(await offerOwner.getAddress());
    const order = await trade.getOrderByIndex(0);
    expect(sellerUser.thumbs_up).to.equal(1n);
    expect(ownerUser.thumbs_down).to.equal(1n);
    expect(order.feedback).to.equal(true);
  });

  it("covers ERC20 createOrder/confirmOrder(captured revert)/cancelOrder", async function () {
    const { trade, token, deployer, offerOwner, seller } = await deployFixture();
    const sellAmount = ethers.parseEther("200");

    await token.transfer(await seller.getAddress(), sellAmount);

    await trade.connect(offerOwner).createOffer(
      await token.getAddress(),
      "USD",
      "1:1",
      "Bank",
      "pub-key",
      "erc20 terms",
      15,
      false,
      sellAmount,
      10,
      sellAmount
    );

    await token.connect(seller).approve(await trade.getAddress(), sellAmount);
    await trade
      .connect(seller)
      .createOrder("Bank", "Seller Name", "seller@example.com", "200 USD", 0, sellAmount);

    expect(await token.balanceOf(await trade.getAddress())).to.equal(sellAmount);

    await expect(
      trade
        .connect(deployer)
        .createOrder("Bank", "Seller Name", "seller@example.com", "200 USD", 0, sellAmount)
    ).to.be.revertedWith("Please approve token as sell amount");

    await trade.connect(offerOwner).buyerConfirm(0);
    await expect(trade.connect(deployer).confirmOrder(0)).to.be.revertedWith(
      "SafeERC20: low-level call failed"
    );
    const stillPendingOrder = await trade.getOrderByIndex(0);
    expect(stillPendingOrder.status).to.equal(0);

    await token.transfer(await seller.getAddress(), sellAmount);
    await token.connect(seller).approve(await trade.getAddress(), sellAmount);
    await trade
      .connect(seller)
      .createOrder("Bank", "Seller Name", "seller@example.com", "200 USD", 0, sellAmount);

    await trade.connect(offerOwner).cancelOrder(1);
    const cancelledOrder = await trade.getOrderByIndex(1);
    expect(cancelledOrder.status).to.equal(2);
  });
});
