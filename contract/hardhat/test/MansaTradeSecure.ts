import { expect } from "chai";
import { ethers } from "hardhat";

describe("MansaTradeSecure", function () {
  async function deployFixture() {
    const [deployer, admin, offerOwner, seller, firDiv, secDiv, randomUser] = await ethers.getSigners();

    const tradeFactory = await ethers.getContractFactory("MansaTradeSecure");
    const trade = (await tradeFactory.deploy(
      await admin.getAddress(),
      await firDiv.getAddress(),
      await secDiv.getAddress()
    )) as any;
    await trade.waitForDeployment();

    const tokenFactory = await ethers.getContractFactory("TestToken");
    const token = (await tokenFactory.deploy(ethers.parseEther("1000000"))) as any;
    await token.waitForDeployment();

    return { trade, token, deployer, admin, offerOwner, seller, firDiv, secDiv, randomUser };
  }

  it("enforces admin controls and validates fee config", async function () {
    const { trade, deployer, admin, firDiv, secDiv, randomUser } = await deployFixture();

    await expect(trade.connect(deployer).updateFee(100, 50, 50)).to.be.revertedWith("You are not admin!");
    await expect(trade.connect(admin).updateFee(600, 50, 50)).to.be.revertedWith("Fee too high");
    await expect(trade.connect(admin).updateFee(100, 70, 20)).to.be.revertedWith("Invalid fee shares");

    await trade.connect(admin).updateFee(100, 70, 30);
    expect(await trade.fee()).to.equal(100n);
    expect(await trade.fir_fee()).to.equal(70n);
    expect(await trade.sec_fee()).to.equal(30n);

    await expect(
      trade.connect(admin).updateFeeDivider(ethers.ZeroAddress, await secDiv.getAddress())
    ).to.be.revertedWith("First divider is zero address");

    await trade.connect(admin).updateFeeDivider(await randomUser.getAddress(), await firDiv.getAddress());
    expect(await trade.fir_div()).to.equal(await randomUser.getAddress());
    expect(await trade.sec_div()).to.equal(await firDiv.getAddress());
  });

  it("keeps owner-only ownership and admin updates controlled", async function () {
    const { trade, deployer, admin, randomUser } = await deployFixture();

    await expect(trade.connect(admin).transferOwnership(await randomUser.getAddress())).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );

    await expect(trade.connect(deployer).updateAdmin(ethers.ZeroAddress)).to.be.revertedWith(
      "Admin is zero address"
    );

    await trade.connect(deployer).updateAdmin(await randomUser.getAddress());
    expect(await trade.admin()).to.equal(await randomUser.getAddress());
  });

  it("validates createOffer and protects update/cancel access", async function () {
    const { trade, offerOwner, randomUser, token } = await deployFixture();
    const amount = ethers.parseEther("1");

    await expect(
      trade
        .connect(offerOwner)
        .createOffer(ethers.ZeroAddress, "USD", "1:1", "Bank", "pk", "terms", 30, false, amount, amount, amount)
    ).to.be.revertedWith("Token offer uses zero token");

    await expect(
      trade.connect(offerOwner).createOffer(
        await token.getAddress(),
        "USD",
        "1:1",
        "Bank",
        "pk",
        "terms",
        30,
        true,
        amount,
        amount,
        amount
      )
    ).to.be.revertedWith("ETH offer must use zero token");

    await expect(
      trade.connect(offerOwner).createOffer(
        ethers.ZeroAddress,
        "USD",
        "1:1",
        "Bank",
        "pk",
        "terms",
        30,
        true,
        amount,
        amount,
        amount - 1n
      )
    ).to.be.revertedWith("Invalid limits");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank",
      "pk",
      "terms",
      30,
      true,
      amount,
      amount,
      amount
    );

    await expect(
      trade
        .connect(randomUser)
        .updateOffer("EUR", "SEPA", "new terms", 20, 0, amount, amount, amount)
    ).to.be.revertedWith("You are not owner of offer.");

    await trade.connect(offerOwner).updateOffer("EUR", "SEPA", "new terms", 20, 0, amount, amount, amount);
    const offer = await trade.getOfferByIndex(0);
    expect(offer.fiat).to.equal("EUR");

    await expect(trade.connect(randomUser).cancelOffer(0)).to.be.revertedWith("You are not owner of offer.");
    await trade.connect(offerOwner).cancelOffer(0);
    const cancelled = await trade.getOfferByIndex(0);
    expect(cancelled.status).to.equal(false);
  });

  it("supports ETH order lifecycle and prevents owner fund redirection", async function () {
    const { trade, deployer, offerOwner, seller, firDiv, secDiv } = await deployFixture();
    const sellAmount = ethers.parseEther("1");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank",
      "pk",
      "terms",
      30,
      true,
      sellAmount,
      sellAmount,
      sellAmount
    );

    await expect(
      trade
        .connect(seller)
        .createOrder("Bank", "Seller", "s@example.com", "1000", 0, sellAmount, { value: sellAmount - 1n })
    ).to.be.revertedWith("Please send as sell amount");

    await trade.connect(seller).createOrder("Bank", "Seller", "s@example.com", "1000", 0, sellAmount, {
      value: sellAmount,
    });

    const ownerBefore = await ethers.provider.getBalance(await deployer.getAddress());
    const sellerBefore = await ethers.provider.getBalance(await seller.getAddress());
    const firBefore = await ethers.provider.getBalance(await firDiv.getAddress());
    const secBefore = await ethers.provider.getBalance(await secDiv.getAddress());

    await trade.connect(offerOwner).buyerConfirm(0);
    await trade.connect(deployer).confirmOrder(0);

    const ownerAfter = await ethers.provider.getBalance(await deployer.getAddress());
    const sellerAfter = await ethers.provider.getBalance(await seller.getAddress());
    const firAfter = await ethers.provider.getBalance(await firDiv.getAddress());
    const secAfter = await ethers.provider.getBalance(await secDiv.getAddress());

    const totalFee = (sellAmount * 45n * 2n) / 10000n;
    const expectedSeller = sellAmount - totalFee;
    const expectedFir = (totalFee * 80n) / 100n;
    const expectedSec = (totalFee * 20n) / 100n;

    expect(ownerAfter).to.be.lte(ownerBefore); // owner cannot receive escrow payout by confirming
    expect(sellerAfter - sellerBefore).to.equal(expectedSeller);
    expect(firAfter - firBefore).to.equal(expectedFir);
    expect(secAfter - secBefore).to.equal(expectedSec);

    const offer = await trade.getOfferByIndex(0);
    expect(offer.status).to.equal(false);
  });

  it("supports ERC20 settlement and fixes secondary fee payout bug", async function () {
    const { trade, token, offerOwner, seller, firDiv, secDiv } = await deployFixture();
    const sellAmount = ethers.parseEther("200");

    await token.transfer(await seller.getAddress(), sellAmount);
    await trade.connect(offerOwner).createOffer(
      await token.getAddress(),
      "USD",
      "1:1",
      "Bank",
      "pk",
      "terms",
      15,
      false,
      sellAmount,
      sellAmount,
      sellAmount
    );

    await token.connect(seller).approve(await trade.getAddress(), sellAmount);
    await trade.connect(seller).createOrder("Bank", "Seller", "s@example.com", "200", 0, sellAmount);
    await trade.connect(offerOwner).buyerConfirm(0);

    const sellerBefore = await token.balanceOf(await seller.getAddress());
    const firBefore = await token.balanceOf(await firDiv.getAddress());
    const secBefore = await token.balanceOf(await secDiv.getAddress());

    await trade.connect(seller).confirmOrder(0);

    const sellerAfter = await token.balanceOf(await seller.getAddress());
    const firAfter = await token.balanceOf(await firDiv.getAddress());
    const secAfter = await token.balanceOf(await secDiv.getAddress());

    const totalFee = (sellAmount * 45n * 2n) / 10000n;
    const expectedSeller = sellAmount - totalFee;
    const expectedFir = (totalFee * 80n) / 100n;
    const expectedSec = (totalFee * 20n) / 100n;

    expect(sellerAfter - sellerBefore).to.equal(expectedSeller);
    expect(firAfter - firBefore).to.equal(expectedFir);
    expect(secAfter - secBefore).to.equal(expectedSec);
  });

  it("restricts feedback to participants, once per order, and no self-rating", async function () {
    const { trade, offerOwner, seller, randomUser } = await deployFixture();
    const sellAmount = ethers.parseEther("0.2");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank",
      "pk",
      "terms",
      30,
      true,
      sellAmount,
      sellAmount,
      sellAmount
    );
    await trade.connect(seller).createOrder("Bank", "Seller", "s@example.com", "200", 0, sellAmount, {
      value: sellAmount,
    });

    await expect(trade.connect(randomUser).thumbUser(true, await seller.getAddress(), 0)).to.be.revertedWith(
      "Not participant"
    );
    await expect(trade.connect(offerOwner).thumbUser(true, await offerOwner.getAddress(), 0)).to.be.revertedWith(
      "You cannot claim yours"
    );

    await trade.connect(offerOwner).thumbUser(true, await seller.getAddress(), 0);
    await expect(trade.connect(seller).thumbUser(false, await offerOwner.getAddress(), 0)).to.be.revertedWith(
      "Feedback already given"
    );
  });

  it("keeps full getter coverage and index guard checks", async function () {
    const { trade, offerOwner, seller } = await deployFixture();
    const sellAmount = ethers.parseEther("0.3");

    await trade.connect(offerOwner).createOffer(
      ethers.ZeroAddress,
      "USD",
      "1:1",
      "Bank",
      "pk",
      "terms",
      30,
      true,
      sellAmount,
      sellAmount,
      sellAmount
    );
    await trade.connect(seller).createOrder("Bank", "Seller", "s@example.com", "300", 0, sellAmount, {
      value: sellAmount,
    });

    const offers = await trade.getOffers();
    const orders = await trade.getOrders();
    const offerIndexes = await trade.getOfferIndexesOfUser(await offerOwner.getAddress());
    const orderIndexesSeller = await trade.getOrderIndexesOfUser(await seller.getAddress());
    const orderIndexesBuyer = await trade.getOrderIndexesOfUser(await offerOwner.getAddress());
    const user = await trade.getUser(await offerOwner.getAddress());

    expect(offers.length).to.equal(1);
    expect(orders.length).to.equal(1);
    expect(offerIndexes[0]).to.equal(0n);
    expect(orderIndexesSeller[0]).to.equal(0n);
    expect(orderIndexesBuyer[0]).to.equal(0n);
    expect(user.user_address).to.equal(await offerOwner.getAddress());

    await expect(trade.getOfferByIndex(1)).to.be.revertedWith("Invalid offer index");
    await expect(trade.getOrderByIndex(1)).to.be.revertedWith("Invalid order index");
  });
});
